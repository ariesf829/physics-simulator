# Project Specification: Interactive Physics & Earthquake Simulator

## 1. Project Overview
An interactive 2D physics simulation and structural analysis web application built with **Matter.js** (or standard HTML5 Canvas 2D physics engine). The simulator allows users to draw custom polygons and primitive shapes, arrange them with transformations (move, scale, rotate), attach them using **LittleBigPlanet-style connectors** (Fixed & Hinge joints), and stress-test the structure using a dynamic live-updating earthquake generator with visual stress heatmaps.

---

## 2. Core Feature Requirements

### A. Primitive & Custom Geometry Editor
* **Primitive Shapes Drawing Mode:**
  * **Rectangle:** Width, height, initial center $(x, y)$. (*API:* `Matter.Bodies.rectangle(x, y, width, height, options)`)
  * **Circle:** Radius, initial center $(x, y)$. (*API:* `Matter.Bodies.circle(x, y, radius, options)`)
  * **Polygon (Regular N-Sided):** Number of sides ($N \ge 3$), radius, initial center $(x, y)$. (*API:* `Matter.Bodies.polygon(x, y, sides, radius, options)`)
  * **Star:** $N$ points, outer radius, inner radius, initial center $(x, y)$. Requires generating $2N$ alternating outer/inner vertices offset by their arithmetic centroid.
  * **Half Circle (Semi-Circle):** Radius, initial center $(x, y)$. Requires generating arc points along $180^\circ$ plus flat base vertices offset by their arithmetic centroid.
* **Custom Polygon Drawing Mode:**
  * Freehand / point-click drawing of convex and concave closed polygons.
  * Automatic centroid calculation prior to passing vertex arrays to `Matter.Bodies.fromVertices` to prevent physics engine anchor/offset bugs.
  * Enforce minimum polygon area and vertex count ($\ge 3$ points).
* **Object Transformation:**
  * Interactive selection, translation (dragging), scaling, and rotation of drawn shapes when in Edit Mode.
  * Bounding box overlay with transformation handles for scale/rotate.

### B. LittleBigPlanet-Style Connectors
* **Joint Placement:**
  * Whenever two or more shapes overlap or intersect, allow placing explicit connection nodes.
* **Connector Types:**
  1. **Pivot / Hinge Connection (`Matter.Constraint` with flexible revolute angle):** Allows free rotation around the pivot point while holding positions relative to each other.
  2. **Fixed / Rigid Connection (`Matter.Constraint` with stiff angular stiffness):** Locks relative orientation and position completely.
* **Visual Anchor Rendering:** Render distinct pins/bolts (circlet icons) at joint attachment coordinates.

### C. Earthquake & Dynamic Controls
* **Live Frequency & Amplitude Modulation:**
  * Frequency Slider (Hz) and Amplitude/Intensity Slider.
  * Modulates the base ground plane position and applies sinusoidal/perlin noise force vectors to ungrounded dynamic bodies.
  * Live updates: Modifying sliders while the simulation is actively running instantly changes physics force calculations without interrupting execution.

### D. Stress Heatmap & Visual Indicators
* **Force / Stress Heatmap on Connectors & Beams:**
  * Calculate reaction force magnitude across `Matter.Constraint` objects at each physics tick:
    $$\text{Stress Ratio} = \frac{\|\mathbf{F}_{\text{constraint}}\|}{\text{Max Breaking Strength}}$$
  * Dynamic color interpolation:
    * **Low Stress (0%–50%):** Smooth transition from Green (`#00FF00`) to Yellow (`#FFFF00`).
    * **High Stress (50%–100%):** Transition from Yellow (`#FFFF00`) to Bright Red (`#FF0000`).
  * Option to trigger joint breakdown/snapping when stress exceeds maximum threshold ($>100\%$).

### E. Simulation State Controls & History
* **Control Toolbar:**
  * **Start / Play:** Unfreezes physics body updates (`runner.enabled = true`).
  * **Pause:** Freezes body states for editing or structural evaluation.
  * **Step:** Advances physics engine by a single fixed time step ($\Delta t = 1/60\text{s}$).
  * **Reset Position:** Restores all drawn shapes and joints to their initial pre-simulation coordinates/rotations.
  * **Clear Canvas / Sandbox:** Flushes all bodies, constraints, and canvas elements.
* **Undo System (`Ctrl + Z` / Button):**
  * Implements an Action Stack (Snapshot / Command pattern) to undo drawing, joint placement, scaling, or deletion operations in reverse order.

---

## 3. Technical Stack & Implementation Guidelines

* **Frontend Engine:** Standard HTML5 Canvas / Modern Vanilla JS or React/TypeScript.
* **Physics Library:** Matter.js (`Matter.Engine`, `Matter.Render`, `Matter.World`, `Matter.Bodies`, `Matter.Constraint`, `Matter.Vertices`).
* **Polygon Centroid Calculation Standard:**
  ```javascript
  // Calculate arithmetic centroid to accurately offset Matter.js body creation
  function getCentroid(vertices) {
    let x = 0, y = 0;
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      x += vertices[i].x;
      y += vertices[i].y;
    }
    return { x: x / n, y: y / n };
  }
  ```
* **Shape Generators Code Snippets:**
  ```javascript
  // 1. Star Vertex Generator for Matter.js fromVertices
  function createStarVertices(x, y, points, outerRadius, innerRadius) {
    const vertices = [];
    const step = Math.PI / points;
    for (let i = 0; i < 2 * points; i++) {
      const r = (i % 2 === 0) ? outerRadius : innerRadius;
      const angle = i * step - Math.PI / 2;
      vertices.push({
        x: x + Math.cos(angle) * r,
        y: y + Math.sin(angle) * r
      });
    }
    return vertices;
  }

  // 2. Half-Circle / Semi-Circle Vertex Generator
  function createHalfCircleVertices(x, y, radius, segments = 10) {
    const vertices = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI;
      vertices.push({
        x: x + Math.cos(angle) * radius,
        y: y - Math.sin(angle) * radius
      });
    }
    return vertices;
  }
  ```

---

## 4. Prompt Examples to Use with GitHub Copilot

| Objective | Copilot Prompt |
| :--- | :--- |
| **Adding Structural Heatmaps** | *"Write a function that iterates through all `Matter.Constraint` instances in `engine.world`, calculates their current reaction force magnitude, maps it to a 0–1 stress ratio, and draws color-coded lines from green to red on canvas."* |
| **Implementing Undo Stack** | *"Implement an Undo Manager class using the Command Pattern that stores historical snapshots of polygon vertices, transformation matrices, and constraint pairings before each user edit."* |
| **Refactoring Polygon Centroids** | *"Ensure that whenever `Bodies.fromVertices` is called, the initial vertices are offset by their arithmetic centroid `getCentroid(points)` so the body anchor point matches the canvas drawing origin."* |