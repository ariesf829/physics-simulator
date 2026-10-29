(() => {
  "use strict";

  const { Engine, Bodies, Body, Composite, Constraint, Vertices, Common } = Matter;
  if (window.decomp && Common.setDecomp) Common.setDecomp(window.decomp);

  const canvas = document.getElementById("worldCanvas");
  const ctx = canvas.getContext("2d");
  const engine = Engine.create({ constraintIterations: 6, positionIterations: 8 });
  engine.gravity.y = 1;
  const bodies = new Map();
  const joints = new Map();
  const undoStack = [];
  const MAX_UNDO = 40;
  let ground;
  let width = 0;
  let height = 0;
  let running = false;
  let lastFrame = 0;
  let accumulator = 0;
  let activeTool = "select";
  let selectedBody = null;
  const multiSel = new Set();
  let pivotMode = false;
  let dragState = null;
  let jointStart = null;
  let customPoints = [];
  let cursorPoint = null;
  let nextBodyId = 1;
  let nextJointId = 1;
  const bodyStress = new Map();
  let brokenJoints = [];
  let peakStress = 0;
  let toastTimer;

  const el = (id) => document.getElementById(id);
  const buttons = [...document.querySelectorAll(".tool-button")];
  const fixedStep = 1000 / 60;

  function showToast(message) {
    const toast = el("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1900);
  }

  function setRunning(value) {
    running = value;
    document.body.classList.toggle("running", running);
    el("playButton").innerHTML = running ? "<span>Ⅱ</span> Pause" : "<span>▶</span> Start";
    el("runLabel").textContent = running ? "SIMULATION RUNNING" : "SIMULATION PAUSED";
    el("statusText").textContent = running ? "SIMULATION RUNNING" : "EDITOR PAUSED";
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function limit(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function readNumber(id, fallback, min, max) {
    const value = Number(el(id).value);
    return Number.isFinite(value) ? limit(value, min, max) : fallback;
  }

  function shapeColor() {
    return el("colorInput").value;
  }

  function captureState() {
    const savedBodies = [...bodies.values()].map((body) => ({
      id: body.plugin.simId,
      position: { x: body.position.x, y: body.position.y },
      angle: body.angle,
      group: body.plugin.group ? body.plugin.group.map((m) => ({ color: m.color, outline: m.outline.map((p) => ({ ...p })) })) : null,
      motor: { ...motorOf(body) },
      vertices: body.plugin.group ? [] : body.plugin.outline
        ? body.plugin.outline.map((point) => ({ ...point }))
        : body.vertices.map((vertex) => {
          const dx = vertex.x - body.position.x;
          const dy = vertex.y - body.position.y;
          const cos = Math.cos(-body.angle);
          const sin = Math.sin(-body.angle);
          return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
        }),
      color: body.render.fillStyle,
      isStatic: body.isStatic,
      initialPosition: body.plugin.initialPosition ? { ...body.plugin.initialPosition } : { ...body.position },
      initialAngle: body.plugin.initialAngle || 0
    }));
    const savedJoints = [...joints.values()].map((joint) => ({
      id: joint.id,
      bodyA: joint.bodyA.plugin.simId,
      bodyB: joint.bodyB.plugin.simId,
      pointA: { ...joint.pointA },
      kind: joint.kind
    }));
    return { bodies: savedBodies, joints: savedJoints, nextBodyId, nextJointId };
  }

  function restoreState(state) {
    Composite.clear(engine.world, false, true);
    bodies.clear();
    joints.clear();
    ground = null;
    for (const saved of state.bodies) {
      const body = buildSavedBody(saved);
      if (!body) continue;
      body.render.strokeStyle = "#b9fff0";
      body.render.lineWidth = 1.5;
      body.plugin.simId = saved.id;
      body.plugin.motor = { ...saved.motor };
      body.plugin.initialPosition = saved.initialPosition;
      body.plugin.initialAngle = saved.initialAngle;
      Body.setAngle(body, saved.angle);
      if (saved.isStatic) Body.setStatic(body, true);
      Composite.add(engine.world, body);
      bodies.set(saved.id, body);
    }
    createGround();
    for (const saved of state.joints) {
      const bodyA = bodies.get(saved.bodyA);
      const bodyB = bodies.get(saved.bodyB);
      if (!bodyA || !bodyB) continue;
      const joint = makeJoint(bodyA, bodyB, saved.pointA, saved.kind, saved.id);
      joints.set(saved.id, joint);
    }
    nextBodyId = state.nextBodyId;
    nextJointId = state.nextJointId;
    brokenJoints = [];
    bodyStress.clear();
    setSelection(null);
    jointStart = null;
    accumulator = 0;
  }

  function saveUndo() {
    undoStack.push(captureState());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    el("undoButton").disabled = undoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length || running) return;
    restoreState(undoStack.pop());
    el("undoButton").disabled = undoStack.length === 0;
    showToast("Last edit undone");
  }

  function addBody(body, color = shapeColor()) {
    if (!body) {
      showToast("This shape could not be created. Check its points and try again.");
      return null;
    }
    body.plugin.simId = nextBodyId++;
    body.plugin.initialPosition = { x: body.position.x, y: body.position.y };
    body.plugin.initialAngle = body.angle;
    body.render.fillStyle = color;
    body.render.strokeStyle = "#b9fff0";
    body.render.lineWidth = 1.5;
    if (el("bodyTypeInput").value === "static") Body.setStatic(body, true);
    Composite.add(engine.world, body);
    bodies.set(body.plugin.simId, body);
    return body;
  }

  function centroid(points) {
    const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
    return { x: total.x / points.length, y: total.y / points.length };
  }

  // Concave shapes become compound bodies whose body.vertices is only the convex hull,
  // so the real outline is kept (relative to the body's centre) for drawing, hit-testing and undo.
  function polygonBody(points, x, y, fill) {
    const center = Vertices.centre(points);
    const outline = points.map((point) => ({ x: point.x - center.x, y: point.y - center.y }));
    const body = Bodies.fromVertices(x, y, [outline.map((point) => ({ ...point }))], {
      friction: 0.75,
      restitution: 0.05,
      render: { fillStyle: fill }
    }, true);
    if (body) body.plugin.outline = outline;
    return body;
  }

  function bodyFromPoints(points, x, y) {
    return polygonBody(points, x, y, shapeColor());
  }

  function worldOutline(body) {
    const outline = body.plugin.outline;
    if (!outline) return body.vertices;
    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    return outline.map((point) => ({
      x: body.position.x + point.x * cos - point.y * sin,
      y: body.position.y + point.x * sin + point.y * cos
    }));
  }

  // Every shape of a body as world polygons (a group has several, anything else has one).
  function worldShapes(body) {
    if (body.plugin.group) return body.plugin.group.map((m) => ({ color: m.color, outline: m.outline.map((p) => anchorWorld(body, p)) }));
    return [{ color: body.render.fillStyle, outline: worldOutline(body).map((p) => ({ x: p.x, y: p.y })) }];
  }

  function hitsBody(body, point) {
    return worldShapes(body).some((shape) => pointInPolygon(shape.outline, point));
  }

  function motorOf(body) {
    if (!body.plugin.motor) body.plugin.motor = { enabled: false, speed: 90, torque: 40 };
    return body.plugin.motor;
  }

  // A group is one compound body: every member shape becomes rigid parts of it,
  // while the member outlines are kept so concave shapes still draw correctly.
  function groupBody(members) {
    const leaves = [];
    for (const member of members) {
      const c = Vertices.centre(member.outline);
      const relative = member.outline.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
      const temp = Bodies.fromVertices(c.x, c.y, [relative], { friction: 0.75, restitution: 0.05 }, true);
      if (!temp) return null;
      leaves.push(...(temp.parts.length > 1 ? temp.parts.slice(1) : [temp]));
    }
    const body = Body.create({ parts: leaves, friction: 0.75, restitution: 0.05, render: { fillStyle: members[0].color } });
    body.plugin.group = members.map((m) => ({ color: m.color, outline: m.outline.map((p) => localPoint(body, p)) }));
    return body;
  }

  // Rebuilds a body from saved data; the saved position is the pivot, which may differ from the centroid.
  function buildSavedBody(saved) {
    let body;
    if (saved.group) {
      const members = saved.group.map((m) => ({
        color: m.color,
        outline: m.outline.map((p) => ({ x: saved.position.x + p.x, y: saved.position.y + p.y }))
      }));
      body = groupBody(members);
    } else {
      const c = Vertices.centre(saved.vertices);
      body = polygonBody(saved.vertices, saved.position.x + c.x, saved.position.y + c.y, saved.color);
    }
    if (body) movePivot(body, saved.position);
    return body;
  }

  // Moves the point a body rotates about without moving its geometry.
  function movePivot(body, world) {
    const local = localPoint(body, world);
    const com = body.plugin.com || { x: 0, y: 0 };
    const newCom = { x: com.x - local.x, y: com.y - local.y };
    // Parallel-axis shift so the inertia matches rotation about the new pivot.
    const extra = (newCom.x * newCom.x + newCom.y * newCom.y) - (com.x * com.x + com.y * com.y);
    Body.setCentre(body, world, false);
    const shift = (p) => ({ x: p.x - local.x, y: p.y - local.y });
    if (body.plugin.outline) body.plugin.outline = body.plugin.outline.map(shift);
    if (body.plugin.group) body.plugin.group = body.plugin.group.map((m) => ({ color: m.color, outline: m.outline.map(shift) }));
    body.plugin.com = newCom;
    if (body.isStatic) {
      if (body._original) body._original.inertia += body._original.mass * extra;
    } else {
      Body.setInertia(body, body.inertia + body.mass * extra);
    }
    body.plugin.initialPosition = { x: body.position.x, y: body.position.y };
  }

  function selectedBodies() {
    if (multiSel.size >= 2) return [...multiSel];
    return selectedBody ? [selectedBody] : [];
  }

  function isSelected(body) {
    return selectedBody === body || multiSel.has(body);
  }

  function applySelectionSet(set) {
    pivotMode = false;
    multiSel.clear();
    if (set.size >= 2) {
      set.forEach((body) => multiSel.add(body));
      selectedBody = null;
    } else {
      selectedBody = set.size ? [...set][0] : null;
    }
    syncInspector();
  }

  function setSelection(body) {
    applySelectionSet(new Set(body ? [body] : []));
  }

  function toggleSelection(body) {
    if (!body) return;
    const set = new Set(selectedBodies());
    if (set.has(body)) set.delete(body); else set.add(body);
    applySelectionSet(set);
  }

  function syncInspector() {
    updateInspectorState();
    const first = selectedBodies()[0];
    if (!first) return;
    el("bodyTypeInput").value = first.isStatic ? "static" : "dynamic";
    const motor = motorOf(first);
    el("motorToggle").checked = motor.enabled;
    el("motorSpeedInput").value = motor.speed;
    el("motorTorqueInput").value = motor.torque;
  }

  function updateInspectorState() {
    const list = selectedBodies();
    const single = list.length === 1 ? list[0] : null;
    const connected = single && [...joints.values()].some((joint) => joint.bodyA === single || joint.bodyB === single);
    if (pivotMode && (running || !single || connected)) pivotMode = false;
    el("groupButton").disabled = running || multiSel.size < 2;
    el("ungroupButton").disabled = running || !single || !single.plugin.group;
    el("pivotButton").disabled = running || !single || !!connected;
    el("pivotButton").title = connected ? "Not available for objects connected by a joint" : "";
    el("pivotButton").classList.toggle("active", pivotMode);
    el("pivotButton").textContent = pivotMode ? "Click the new pivot point…" : "Set pivot point";
    for (const id of ["motorToggle", "motorSpeedInput", "motorTorqueInput"]) el(id).disabled = list.length === 0;
  }

  function registerBody(body, color) {
    body.plugin.simId = nextBodyId++;
    body.plugin.initialPosition = { x: body.position.x, y: body.position.y };
    body.plugin.initialAngle = body.angle;
    body.render.fillStyle = color;
    body.render.strokeStyle = "#b9fff0";
    body.render.lineWidth = 1.5;
    Composite.add(engine.world, body);
    bodies.set(body.plugin.simId, body);
  }

  function groupSelection() {
    const list = selectedBodies();
    if (list.length < 2 || running) return;
    const body = groupBody(list.flatMap(worldShapes));
    if (!body) {
      showToast("These shapes could not be grouped.");
      return;
    }
    saveUndo();
    const members = new Set(list);
    for (const [id, joint] of joints) {
      const aIn = members.has(joint.bodyA);
      const bIn = members.has(joint.bodyB);
      if (!aIn && !bIn) continue;
      removeConstraints(joint);
      if (aIn && bIn) {
        joints.delete(id);
        continue;
      }
      if (aIn) {
        const pivot = anchorWorld(joint.bodyA, joint.pointA);
        joint.bodyA = body;
        joint.pointA = localPoint(body, pivot);
      } else {
        joint.bodyB = body;
      }
    }
    for (const member of list) {
      Composite.remove(engine.world, member);
      bodies.delete(member.plugin.simId);
    }
    registerBody(body, body.render.fillStyle);
    if (list.some((member) => member.isStatic)) Body.setStatic(body, true);
    for (const joint of joints.values()) if (joint.bodyA === body || joint.bodyB === body) rebuildConstraints(joint);
    setSelection(body);
    showToast("Shapes grouped");
  }

  function ungroupSelection() {
    const body = selectedBody;
    if (!body || !body.plugin.group || running) return;
    saveUndo();
    const created = worldShapes(body).map((shape) => {
      const c = Vertices.centre(shape.outline);
      const part = polygonBody(shape.outline, c.x, c.y, shape.color);
      if (!part) return null;
      registerBody(part, shape.color);
      if (body.isStatic) Body.setStatic(part, true);
      return part;
    }).filter(Boolean);
    if (!created.length) return;
    for (const [id, joint] of joints) {
      if (joint.bodyA !== body && joint.bodyB !== body) continue;
      const pivot = anchorWorld(joint.bodyA, joint.pointA);
      const owner = created.find((part) => hitsBody(part, pivot))
        || created.reduce((best, part) => (Math.hypot(part.position.x - pivot.x, part.position.y - pivot.y) < Math.hypot(best.position.x - pivot.x, best.position.y - pivot.y) ? part : best));
      removeConstraints(joint);
      if (joint.bodyA === body) {
        joint.bodyA = owner;
        joint.pointA = localPoint(owner, pivot);
      } else {
        joint.bodyB = owner;
      }
      rebuildConstraints(joint);
    }
    Composite.remove(engine.world, body);
    bodies.delete(body.plugin.simId);
    applySelectionSet(new Set(created));
    showToast("Group split into shapes");
  }

  function applyPivot(point) {
    const body = selectedBody;
    if (!body || !hitsBody(body, point)) {
      showToast("Click inside the object to set its pivot.");
      return;
    }
    saveUndo();
    movePivot(body, point);
    pivotMode = false;
    showToast("Pivot point updated");
  }

  function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
  }

  function selfIntersects(points) {
    const n = points.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  function regularPoints(center, sides, radius) {
    const points = [];
    for (let i = 0; i < sides; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / sides);
      points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    return points;
  }

  function starPoints(center, pointsCount, outer, inner) {
    const points = [];
    for (let i = 0; i < pointsCount * 2; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = i * Math.PI / pointsCount - Math.PI / 2;
      points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    return points;
  }

  function halfCirclePoints(center, radius) {
    const points = [];
    const segments = 18;
    for (let i = 0; i <= segments; i++) {
      const angle = Math.PI - (i / segments) * Math.PI;
      points.push({ x: center.x + Math.cos(angle) * radius, y: center.y - Math.sin(angle) * radius });
    }
    return points;
  }

  function createShape(tool, point) {
    saveUndo();
    let body;
    if (tool === "rectangle") {
      body = Bodies.rectangle(point.x, point.y, readNumber("widthInput", 120, 10, 600), readNumber("heightInput", 70, 10, 600), { friction: 0.75, restitution: 0.05 });
    } else if (tool === "circle") {
      body = Bodies.circle(point.x, point.y, readNumber("radiusInput", 48, 8, 300), { friction: 0.75, restitution: 0.05, circleSegments: 32 });
    } else if (tool === "polygon") {
      body = bodyFromPoints(regularPoints(point, readNumber("sidesInput", 6, 3, 16), readNumber("radiusInput", 48, 8, 300)), point.x, point.y);
    } else if (tool === "star") {
      const outer = readNumber("radiusInput", 48, 8, 300);
      const inner = Math.min(outer - 1, readNumber("innerInput", 22, 4, 300));
      body = bodyFromPoints(starPoints(point, readNumber("sidesInput", 5, 3, 16), outer, inner), point.x, point.y);
    } else if (tool === "semicircle") {
      body = bodyFromPoints(halfCirclePoints(point, readNumber("radiusInput", 48, 8, 300)), point.x, point.y);
    }
    if (body) {
      addBody(body);
      setSelection(body);
      el("canvasInstructions").hidden = true;
    }
  }

  function finishCustomPolygon() {
    if (customPoints.length < 3) {
      showToast("A polygon needs at least 3 points.");
      return false;
    }
    const area = Math.abs(Vertices.area(customPoints));
    if (area < 100) {
      showToast("Polygon is too small. Draw an area of at least 100 px².");
      return false;
    }
    const points = customPoints.map((point) => ({ ...point }));
    if (selfIntersects(points)) {
      showToast("Edges cross each other. Draw a shape that does not intersect itself.");
      return false;
    }
    saveUndo();
    const center = Vertices.centre(points);
    const body = bodyFromPoints(points, center.x, center.y);
    if (body) {
      addBody(body);
      setSelection(body);
      el("canvasInstructions").hidden = true;
    }
    customPoints = [];
    return true;
  }

  function localPoint(body, worldPoint) {
    const dx = worldPoint.x - body.position.x;
    const dy = worldPoint.y - body.position.y;
    const cos = Math.cos(-body.angle);
    const sin = Math.sin(-body.angle);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  // A joint is a record that owns its Matter constraints: a hinge is one pin,
  // a fixed joint is a two-pin weld (Matter has no real angular lock).
  function buildConstraints(joint) {
    const { bodyA, bodyB } = joint;
    const pivot = anchorWorld(bodyA, joint.pointA);
    joint.pointB = localPoint(bodyB, pivot);
    let pins = [pivot];
    if (joint.kind === "fixed") {
      let dx = bodyB.position.x - bodyA.position.x;
      let dy = bodyB.position.y - bodyA.position.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) { dx = 1; dy = 0; } else { dx /= length; dy /= length; }
      const spread = 24;
      pins = [{ x: pivot.x + dx * spread, y: pivot.y + dy * spread }, { x: pivot.x - dx * spread, y: pivot.y - dy * spread }];
    }
    joint.constraints = pins.map((pin) => {
      const constraint = Constraint.create({
        bodyA,
        bodyB,
        // Matter expects anchor offsets in world orientation at creation time.
        pointA: { x: pin.x - bodyA.position.x, y: pin.y - bodyA.position.y },
        pointB: { x: pin.x - bodyB.position.x, y: pin.y - bodyB.position.y },
        length: 0,
        stiffness: joint.kind === "fixed" ? 1 : 0.9,
        damping: joint.kind === "fixed" ? 0.1 : 0.05,
        render: { visible: false }
      });
      constraint.plugin.joint = joint;
      constraint.plugin.localA = localPoint(bodyA, pin);
      constraint.plugin.localB = localPoint(bodyB, pin);
      return constraint;
    });
    Composite.add(engine.world, joint.constraints);
  }

  function removeConstraints(joint) {
    if (joint.constraints) Composite.remove(engine.world, joint.constraints);
    joint.constraints = [];
  }

  function rebuildConstraints(joint) {
    removeConstraints(joint);
    buildConstraints(joint);
  }

  function makeJoint(bodyA, bodyB, pointA, kind, id = nextJointId++) {
    const joint = { id, kind, bodyA, bodyB, pointA: { ...pointA }, pointB: { x: 0, y: 0 }, constraints: [], stress: 0, force: 0, load: 0 };
    buildConstraints(joint);
    return joint;
  }

  function createJoint(bodyA, bodyB, pivot) {
    if (!bodyA || !bodyB || bodyA === bodyB) {
      showToast("Select two different shapes for a joint.");
      jointStart = null;
      return;
    }
    saveUndo();
    // Both shapes pin to the point picked on the first click, so nothing is pulled together.
    const joint = makeJoint(bodyA, bodyB, localPoint(bodyA, pivot), activeTool);
    joints.set(joint.id, joint);
    jointStart = null;
    showToast(`${activeTool === "fixed" ? "Fixed" : "Hinge"} joint placed`);
  }

  function bodyAt(point, exclude = null) {
    for (const body of [...bodies.values()].reverse()) {
      if (body !== exclude && hitsBody(body, point)) return body;
    }
    return null;
  }

  // Ray casting works for concave outlines and either winding order.
  function pointInPolygon(poly, p) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function deleteBody(body, skipUndo = false) {
    if (!body) return;
    if (!skipUndo) saveUndo();
    for (const [id, joint] of joints) {
      if (joint.bodyA === body || joint.bodyB === body) {
        removeConstraints(joint);
        joints.delete(id);
      }
    }
    Composite.remove(engine.world, body);
    bodies.delete(body.plugin.simId);
    if (selectedBody === body || multiSel.has(body)) {
      const rest = new Set(selectedBodies());
      rest.delete(body);
      applySelectionSet(rest);
    }
    if (bodies.size === 0) el("canvasInstructions").hidden = false;
  }

  function pointerDown(event) {
    if (running) return;
    const point = position(event);
    let hit = bodyAt(point);
    if (activeTool === "custom") {
      const first = customPoints[0];
      const last = customPoints[customPoints.length - 1];
      if (customPoints.length >= 3 && Math.hypot(point.x - first.x, point.y - first.y) < 12) {
        finishCustomPolygon();
      } else if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 6) {
        customPoints.push(point);
      }
      return;
    }
    if (["rectangle", "circle", "polygon", "star", "semicircle"].includes(activeTool)) {
      createShape(activeTool, point);
      return;
    }
    if (activeTool === "select" && pivotMode) {
      applyPivot(point);
      return;
    }
    if (activeTool === "select" && selectedBody) {
      const bounds = selectedBody.bounds;
      const handles = [
        { x: bounds.min.x, y: bounds.min.y },
        { x: bounds.max.x, y: bounds.min.y },
        { x: bounds.min.x, y: bounds.max.y },
        { x: bounds.max.x, y: bounds.max.y },
        { x: (bounds.min.x + bounds.max.x) / 2, y: bounds.min.y - 25 }
      ];
      if (handles.some((handle) => Math.hypot(point.x - handle.x, point.y - handle.y) < 10)) hit = selectedBody;
    }
    if (activeTool === "delete") {
      deleteBody(hit);
      return;
    }
    if (activeTool === "hinge" || activeTool === "fixed") {
      if (!jointStart) {
        if (!hit) return;
        jointStart = { body: hit, point };
        showToast("Pivot set. Now click the second shape");
      } else {
        createJoint(jointStart.body, bodyAt(point, jointStart.body), jointStart.point);
      }
      return;
    }
    if (event.shiftKey) {
      toggleSelection(hit);
      return;
    }
    if (hit && multiSel.has(hit)) {
      saveUndo();
      dragState = {
        type: "move",
        body: hit,
        items: [...multiSel].map((body) => ({ body, offset: { x: point.x - body.position.x, y: point.y - body.position.y } }))
      };
      return;
    }
    setSelection(hit);
    if (!hit) return;
    saveUndo();
    const bounds = hit.bounds;
    const corners = [
      { x: bounds.min.x, y: bounds.min.y },
      { x: bounds.max.x, y: bounds.min.y },
      { x: bounds.min.x, y: bounds.max.y },
      { x: bounds.max.x, y: bounds.max.y }
    ];
    const rotateHandle = { x: (bounds.min.x + bounds.max.x) / 2, y: bounds.min.y - 25 };
    if (Math.hypot(point.x - rotateHandle.x, point.y - rotateHandle.y) < 10) {
      dragState = {
        type: "rotate",
        body: hit,
        startAngle: Math.atan2(point.y - hit.position.y, point.x - hit.position.x) - hit.angle
      };
    } else {
      const corner = corners.find((candidate) => Math.hypot(point.x - candidate.x, point.y - candidate.y) < 9);
      if (corner) {
        dragState = {
          type: "scale",
          body: hit,
          startVector: { x: corner.x - hit.position.x, y: corner.y - hit.position.y },
          lastScale: { x: 1, y: 1 }
        };
      } else {
        dragState = { type: "move", body: hit, items: [{ body: hit, offset: { x: point.x - hit.position.x, y: point.y - hit.position.y } }] };
      }
    }
  }

  function pointerMove(event) {
    const point = position(event);
    cursorPoint = point;
    el("coordinateReadout").innerHTML = `X: ${Math.round(point.x)} &nbsp; Y: ${Math.round(point.y)}`;
    if (!dragState || running) return;
    const body = dragState.body;
    if (dragState.type === "move") {
      for (const item of dragState.items) Body.setPosition(item.body, { x: point.x - item.offset.x, y: point.y - item.offset.y });
    } else if (dragState.type === "rotate") {
      Body.setAngle(body, Math.atan2(point.y - body.position.y, point.x - body.position.x) - dragState.startAngle);
    } else if (dragState.type === "scale") {
      const sx = (point.x - body.position.x) / dragState.startVector.x;
      const sy = (point.y - body.position.y) / dragState.startVector.y;
      const target = limit((sx + sy) / 2, 0.1, 5);
      const factor = target / dragState.lastScale.x;
      Body.scale(body, factor, factor);
      dragState.lastScale = { x: target, y: target };
      if (body.plugin.outline) body.plugin.outline = body.plugin.outline.map((p) => ({ x: p.x * factor, y: p.y * factor }));
      if (body.plugin.group) {
        body.plugin.group = body.plugin.group.map((m) => ({ color: m.color, outline: m.outline.map((p) => ({ x: p.x * factor, y: p.y * factor })) }));
      }
      if (body.plugin.com) body.plugin.com = { x: body.plugin.com.x * factor, y: body.plugin.com.y * factor };
      for (const joint of joints.values()) {
        if (joint.bodyA === body) joint.pointA = { x: joint.pointA.x * factor, y: joint.pointA.y * factor };
        if (joint.bodyB === body) joint.pointB = { x: joint.pointB.x * factor, y: joint.pointB.y * factor };
      }
    }
  }

  function pointerUp() {
    if (dragState) {
      const moved = new Set(dragState.items ? dragState.items.map((item) => item.body) : [dragState.body]);
      for (const body of moved) {
        body.plugin.initialPosition = { x: body.position.x, y: body.position.y };
        body.plugin.initialAngle = body.angle;
      }
      // A moved body keeps its pivot; the other body is re-pinned at that world point.
      for (const joint of joints.values()) {
        if (moved.has(joint.bodyA)) {
          rebuildConstraints(joint);
        } else if (moved.has(joint.bodyB)) {
          joint.pointA = localPoint(joint.bodyA, anchorWorld(joint.bodyB, joint.pointB));
          rebuildConstraints(joint);
        }
      }
    }
    dragState = null;
  }

  function canvasClick(event) {
    if (activeTool !== "custom" || event.detail > 1) return;
  }

  function setTool(tool) {
    activeTool = tool;
    jointStart = null;
    buttons.forEach((button) => button.classList.toggle("selected", button.dataset.tool === tool));
    canvas.style.cursor = tool === "select" ? "default" : tool === "custom" ? "crosshair" : "cell";
    if (tool === "custom") showToast("Click to add points; press Enter or double-click to finish.");
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    createGround();
  }

  function createGround() {
    if (ground) Composite.remove(engine.world, ground);
    ground = Bodies.rectangle(width / 2, height - 20, width + 160, 48, { isStatic: true, friction: 0.9, render: { fillStyle: "#263844" } });
    Composite.add(engine.world, ground);
  }

  function stressColor(ratio) {
    const stops = ratio < 0.5
      ? [0, 255, 0].map((value, i) => value + ([255, 255, 0][i] - value) * (ratio * 2))
      : [255, 255, 0].map((value, i) => value + ([255, 0, 0][i] - value) * ((ratio - 0.5) * 2));
    return `rgb(${stops.map(Math.round).join(",")})`;
  }

  function anchorWorld(body, local) {
    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    return { x: body.position.x + local.x * cos - local.y * sin, y: body.position.y + local.x * sin + local.y * cos };
  }

  // Matter exposes no reaction forces, so wrap its constraint solver and record how much
  // positional correction each constraint applies per step: F ≈ m_eff · correction / dt².
  const baseSolve = Constraint.solve;
  Constraint.solve = function (constraint, timeScale) {
    const joint = constraint.plugin.joint;
    if (joint && constraint.bodyA && constraint.bodyB) {
      const a = anchorWorld(constraint.bodyA, constraint.plugin.localA);
      const b = anchorWorld(constraint.bodyB, constraint.plugin.localB);
      joint.load += Math.hypot(a.x - b.x, a.y - b.y) * constraint.stiffness;
    }
    return baseSolve.call(this, constraint, timeScale);
  };

  function updateStress() {
    const maxForce = readNumber("breakForceInput", 0.08, 0.005, 2);
    const dt = fixedStep;
    bodyStress.clear();
    for (const [id, joint] of joints) {
      const invMass = (joint.bodyA.isStatic ? 0 : 1 / joint.bodyA.mass) + (joint.bodyB.isStatic ? 0 : 1 / joint.bodyB.mass);
      const mass = invMass > 0 ? 1 / invMass : 0;
      const raw = 0.1 * mass * joint.load / (dt * dt);
      joint.load = 0;
      joint.force = joint.force * 0.7 + raw * 0.3;
      joint.stress = limit(joint.force / maxForce, 0, 1);
      for (const body of [joint.bodyA, joint.bodyB]) bodyStress.set(body, Math.max(bodyStress.get(body) || 0, joint.stress));
      if (el("breakToggle").checked && joint.force > maxForce) {
        removeConstraints(joint);
        joints.delete(id);
        brokenJoints.push(joint);
        showToast("Joint snapped: breaking force exceeded");
      }
    }
    const peak = Math.max(0, ...[...joints.values()].map((joint) => joint.stress));
    el("maxStress").textContent = `${Math.round(peak * 100)}%`;
  }

  function applyMotors() {
    const dt = fixedStep / 1000;
    for (const body of bodies.values()) {
      const motor = body.plugin.motor;
      if (!motor || !motor.enabled) continue;
      const target = motor.speed * Math.PI / 180 * dt;
      if (body.isStatic) {
        // Static bodies have no torque response, so they are turned directly.
        Body.setAngle(body, body.angle + target);
        continue;
      }
      // Torque that would reach the target speed this step, capped by the motor's strength.
      const needed = (target - (body.angle - body.anglePrev)) / (body.inverseInertia * fixedStep * fixedStep);
      const maxTorque = motor.torque * 0.1;
      body.torque += limit(needed, -maxTorque, maxTorque);
    }
  }

  function updatePhysics(delta) {
    Engine.update(engine, delta);
    updateStress();
    applyMotors();
    const intensity = Number(el("intensityInput").value);
    const frequency = Number(el("frequencyInput").value);
    const time = performance.now() / 1000;
    if (ground && running) {
      Body.setPosition(ground, { x: width / 2 + Math.sin(time * frequency * Math.PI * 2) * intensity * 0.18, y: height - 20 + Math.sin(time * frequency * Math.PI * 2) * intensity * 0.035 });
    }
    if (running && intensity > 0) {
      const wave = Math.sin(time * frequency * Math.PI * 2);
      for (const body of bodies.values()) {
        if (body.isStatic) continue;
        Body.applyForce(body, body.position, { x: body.mass * wave * intensity * 0.00016, y: body.mass * Math.cos(time * frequency * Math.PI * 2) * intensity * 0.000025 });
      }
    }
  }

  function drawBody(body) {
    const stressed = bodyStress.has(body);
    for (const shape of worldShapes(body)) {
      const vertices = shape.outline;
      if (!vertices.length) continue;
      ctx.beginPath();
      ctx.moveTo(vertices[0].x, vertices[0].y);
      for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y);
      ctx.closePath();
      ctx.fillStyle = shape.color || "#42d6bd";
      ctx.fill();
      ctx.lineWidth = stressed ? 3 : isSelected(body) ? 2 : 1;
      ctx.strokeStyle = stressed ? stressColor(bodyStress.get(body)) : isSelected(body) ? "#f0fff9" : (body.isStatic ? "#3d5866" : "#b9fff0");
      ctx.stroke();
    }
    const motor = body.plugin.motor;
    if (motor && motor.enabled) drawMotor(body, motor);
    if (isSelected(body) && !running) {
      ctx.beginPath();
      ctx.moveTo(body.position.x - 5, body.position.y);
      ctx.lineTo(body.position.x + 5, body.position.y);
      ctx.moveTo(body.position.x, body.position.y - 5);
      ctx.lineTo(body.position.x, body.position.y + 5);
      ctx.strokeStyle = "#ffcf69";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Circular arrow at the pivot; its direction shows the sign of the motor speed.
  function drawMotor(body, motor) {
    const { x, y } = body.position;
    const dir = motor.speed >= 0 ? 1 : -1;
    const start = body.angle - dir * 2.2;
    const end = body.angle + dir * 2.2;
    ctx.beginPath();
    ctx.arc(x, y, 14, start, end, dir < 0);
    ctx.strokeStyle = "#13212b";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = "#ffcf69";
    ctx.lineWidth = 2;
    ctx.stroke();
    const tip = { x: x + Math.cos(end) * 14, y: y + Math.sin(end) * 14 };
    const tangent = end + dir * Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(tip.x + Math.cos(tangent) * 6, tip.y + Math.sin(tangent) * 6);
    ctx.lineTo(tip.x + Math.cos(tangent + 2.5) * 6, tip.y + Math.sin(tangent + 2.5) * 6);
    ctx.lineTo(tip.x + Math.cos(tangent - 2.5) * 6, tip.y + Math.sin(tangent - 2.5) * 6);
    ctx.closePath();
    ctx.fillStyle = "#ffcf69";
    ctx.fill();
  }

  function drawJoint(joint) {
    const pivot = anchorWorld(joint.bodyA, joint.pointA);
    const color = stressColor(joint.stress || 0);
    if (joint.kind === "fixed" && joint.constraints.length === 2) {
      const [first, second] = joint.constraints.map((c) => anchorWorld(c.bodyA, c.plugin.localA));
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(second.x, second.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#13212b";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (joint.kind === "fixed") {
      ctx.beginPath();
      ctx.moveTo(pivot.x - 4, pivot.y - 4);
      ctx.lineTo(pivot.x + 4, pivot.y + 4);
      ctx.moveTo(pivot.x + 4, pivot.y - 4);
      ctx.lineTo(pivot.x - 4, pivot.y + 4);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function drawSelection() {
    if (running) return;
    if (multiSel.size >= 2) {
      const all = [...multiSel].map((body) => body.bounds);
      const x0 = Math.min(...all.map((b) => b.min.x));
      const y0 = Math.min(...all.map((b) => b.min.y));
      const x1 = Math.max(...all.map((b) => b.max.x));
      const y1 = Math.max(...all.map((b) => b.max.y));
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#ffcf69cc";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
      ctx.restore();
      return;
    }
    if (!selectedBody) return;
    const bounds = selectedBody.bounds;
    const x = bounds.min.x;
    const y = bounds.min.y;
    const w = bounds.max.x - x;
    const h = bounds.max.y - y;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#d7e4ebaa";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.fillStyle = "#f2fbff";
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
      ctx.strokeStyle = "#23434c";
      ctx.strokeRect(hx - 3, hy - 3, 6, 6);
    }
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w / 2, y - 22);
    ctx.strokeStyle = "#a9bbc5";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w / 2, y - 25, 4, 0, Math.PI * 2);
    ctx.fillStyle = varTeal();
    ctx.fill();
    ctx.restore();
  }

  function varTeal() {
    return "#42d6bd";
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    if (running) {
      const now = performance.now();
      const elapsed = Math.min(now - (lastFrame || now), 100);
      lastFrame = now;
      accumulator += elapsed;
      while (accumulator >= fixedStep) {
        updatePhysics(fixedStep);
        accumulator -= fixedStep;
      }
    } else {
      lastFrame = performance.now();
    }
    if (ground) {
      const b = ground.bounds;
      ctx.fillStyle = "#263844";
      ctx.fillRect(b.min.x, b.min.y, b.max.x - b.min.x, b.max.y - b.min.y);
      ctx.strokeStyle = "#4d6c78";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.min.x, b.min.y);
      ctx.lineTo(b.max.x, b.min.y);
      ctx.stroke();
    }
    for (const body of bodies.values()) drawBody(body);
    for (const joint of joints.values()) drawJoint(joint);
    if (jointStart) {
      ctx.beginPath();
      ctx.arc(jointStart.point.x, jointStart.point.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffcf69";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (customPoints.length) {
      ctx.beginPath();
      ctx.moveTo(customPoints[0].x, customPoints[0].y);
      customPoints.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      if (cursorPoint) ctx.lineTo(cursorPoint.x, cursorPoint.y);
      ctx.strokeStyle = "#ffb17e";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (customPoints.length >= 3) {
        ctx.beginPath();
        ctx.arc(customPoints[0].x, customPoints[0].y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      customPoints.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#ffb17e";
        ctx.fill();
      });
    }
    drawSelection();
    updateInspectorState();
    requestAnimationFrame(render);
  }

  function clearCanvas() {
    if (running) setRunning(false);
    if (bodies.size === 0 && joints.size === 0) return;
    saveUndo();
    for (const joint of joints.values()) removeConstraints(joint);
    for (const body of bodies.values()) Composite.remove(engine.world, body);
    bodies.clear();
    joints.clear();
    brokenJoints = [];
    bodyStress.clear();
    setSelection(null);
    customPoints = [];
    jointStart = null;
    el("canvasInstructions").hidden = false;
    showToast("Canvas cleared");
  }

  function resetPositions() {
    if (running) setRunning(false);
    for (const joint of brokenJoints) joints.set(joint.id, joint);
    brokenJoints = [];
    for (const joint of joints.values()) joint.force = joint.stress = joint.load = 0;
    bodyStress.clear();
    for (const body of bodies.values()) {
      const initial = body.plugin.initialPosition;
      if (!initial) continue;
      Body.setPosition(body, initial);
      Body.setAngle(body, body.plugin.initialAngle || 0);
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
      body.isSleeping = false;
    }
    for (const joint of joints.values()) rebuildConstraints(joint);
    accumulator = 0;
  }

  buttons.forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("dblclick", (event) => {
    if (activeTool === "custom") {
      event.preventDefault();
      if (customPoints.length) finishCustomPolygon();
    }
  });
  el("bodyTypeInput").addEventListener("change", (event) => {
    const list = selectedBodies();
    if (!list.length || running) return;
    saveUndo();
    for (const body of list) {
      Body.setStatic(body, event.target.value === "static");
      body.isSleeping = false;
    }
  });
  el("groupButton").addEventListener("click", groupSelection);
  el("ungroupButton").addEventListener("click", ungroupSelection);
  el("pivotButton").addEventListener("click", () => {
    if (el("pivotButton").disabled) return;
    setTool("select");
    pivotMode = !pivotMode;
    if (pivotMode) showToast("Click inside the object to set its pivot point");
  });
  function motorChange(apply) {
    const list = selectedBodies();
    if (!list.length) return;
    saveUndo();
    for (const body of list) apply(motorOf(body));
  }
  el("motorToggle").addEventListener("change", (event) => motorChange((motor) => { motor.enabled = event.target.checked; }));
  el("motorSpeedInput").addEventListener("change", (event) => {
    const speed = readNumber("motorSpeedInput", 90, -5000, 5000);
    event.target.value = speed;
    motorChange((motor) => { motor.speed = speed; });
  });
  el("motorTorqueInput").addEventListener("change", (event) => {
    const torque = readNumber("motorTorqueInput", 40, 1, 100);
    event.target.value = torque;
    motorChange((motor) => { motor.torque = torque; });
  });
  canvas.addEventListener("click", canvasClick);
  el("playButton").addEventListener("click", () => setRunning(!running));
  el("stepButton").addEventListener("click", () => {
    if (!running) updatePhysics(fixedStep);
  });
  el("resetButton").addEventListener("click", resetPositions);
  el("undoButton").addEventListener("click", undo);
  el("clearButton").addEventListener("click", clearCanvas);
  el("frequencyInput").addEventListener("input", (event) => { el("frequencyValue").textContent = `${Number(event.target.value).toFixed(1)} Hz`; });
  el("intensityInput").addEventListener("input", (event) => { el("intensityValue").textContent = `${event.target.value}%`; });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    } else if (event.key === "Enter" && activeTool === "custom") {
      finishCustomPolygon();
    } else if (event.key.toLowerCase() === "v" && !event.ctrlKey && !event.metaKey) {
      setTool("select");
    } else if (event.key.toLowerCase() === "p" && !event.ctrlKey && !event.metaKey) {
      setTool("custom");
    } else if (event.key === "Escape") {
      customPoints = [];
      jointStart = null;
      pivotMode = false;
    } else if ((event.key === "Delete" || event.key === "Backspace") && !running && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) {
      const list = selectedBodies();
      if (!list.length) return;
      event.preventDefault();
      saveUndo();
      list.forEach((body) => deleteBody(body, true));
    }
  });
  window.addEventListener("resize", resize);
  resize();
  el("undoButton").disabled = true;
  requestAnimationFrame(render);
})();
