import test from 'node:test';
import assert from 'node:assert/strict';
import {
    INTERACTION_MODE,
    applyPanTranslation,
    classifyPointerInteraction,
    computeTiltAngleFromDrag,
    computeZoomedCameraDistance,
    installSafeControlsRefinement,
    resolveLeftMouseAction,
    shouldTranslateCameraForTargetDelta
} from '../safe-controls-refinement.mjs';

class FakeVector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    copy(other) {
        this.x = other.x;
        this.y = other.y;
        this.z = other.z;
        return this;
    }

    add(other) {
        this.x += other.x;
        this.y += other.y;
        this.z += other.z;
        return this;
    }

    subVectors(a, b) {
        this.x = a.x - b.x;
        this.y = a.y - b.y;
        this.z = a.z - b.z;
        return this;
    }

    length() {
        return Math.hypot(this.x, this.y, this.z);
    }

    setLength(nextLength) {
        const currentLength = this.length();
        if (currentLength <= 1e-12) return this;
        const scale = nextLength / currentLength;
        this.x *= scale;
        this.y *= scale;
        this.z *= scale;
        return this;
    }
}

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, handler, options) {
        const capture = Boolean(typeof options === 'boolean' ? options : options && options.capture);
        const entries = this.listeners.get(type) || [];
        entries.push({ handler, capture });
        this.listeners.set(type, entries);
    }

    removeEventListener(type, handler, options) {
        const capture = Boolean(typeof options === 'boolean' ? options : options && options.capture);
        const entries = this.listeners.get(type) || [];
        const filtered = entries.filter((entry) => !(entry.handler === handler && entry.capture === capture));
        this.listeners.set(type, filtered);
    }

    dispatch(type, event = {}) {
        const entries = this.listeners.get(type) || [];
        for (const entry of [...entries]) {
            entry.handler(event);
        }
    }
}

function makePointerEvent(overrides = {}) {
    return {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientY: 0,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        stopPropagation() {
            this.propagationStopped = true;
        },
        ...overrides
    };
}

function createHarness() {
    const windowTarget = new FakeEventTarget();
    const domElement = new FakeEventTarget();
    const lotEditState = { active: false };
    const controls = {
        mouseButtons: { LEFT: 0 },
        minDistance: 0.6,
        maxDistance: 10,
        target: new FakeVector3(0, 0, 0),
        enabled: true,
        updateCalls: 0,
        rotateUpCalls: [],
        update() {
            this.updateCalls += 1;
        },
        rotateUp(amount) {
            this.rotateUpCalls.push(amount);
        }
    };
    const camera = {
        position: new FakeVector3(0, 0, 5)
    };
    const MOUSE = { PAN: 1, DOLLY: 2, ROTATE: 3 };
    let navigateCalls = 0;
    const installResult = installSafeControlsRefinement({
        windowTarget,
        domElement,
        controls,
        camera,
        lotEditState,
        MOUSE,
        Vector3: FakeVector3,
        onUserNavigate() {
            navigateCalls += 1;
        }
    });
    return {
        windowTarget,
        domElement,
        lotEditState,
        controls,
        camera,
        MOUSE,
        installResult,
        getNavigateCalls: () => navigateCalls
    };
}

function makeRng(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}

function randInRange(rng, min, max) {
    return min + (max - min) * rng();
}

function approxEqual(actual, expected, epsilon = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `Expected ${expected}, got ${actual}`);
}

test('classifyPointerInteraction maps desktop and touch interactions correctly', () => {
    assert.equal(classifyPointerInteraction({ pointerType: 'mouse', button: 0 }), INTERACTION_MODE.PAN);
    assert.equal(classifyPointerInteraction({ pointerType: 'mouse', button: 0, altKey: true }), INTERACTION_MODE.ORBIT);
    assert.equal(classifyPointerInteraction({ pointerType: 'mouse', button: 0, shiftKey: true }), INTERACTION_MODE.TILT);
    assert.equal(classifyPointerInteraction({ pointerType: 'mouse', button: 1 }), INTERACTION_MODE.DOLLY);
    assert.equal(classifyPointerInteraction({ pointerType: 'touch', activeTouchCount: 1 }), INTERACTION_MODE.PAN);
    assert.equal(classifyPointerInteraction({ pointerType: 'touch', activeTouchCount: 2 }), INTERACTION_MODE.PINCH);
});

test('resolveLeftMouseAction and camera translation gate work as expected', () => {
    assert.equal(resolveLeftMouseAction({ altKey: true }), 'rotate');
    assert.equal(resolveLeftMouseAction({ altKey: false }), 'pan');
    assert.equal(shouldTranslateCameraForTargetDelta({
        userInteracting: true,
        interactionMode: INTERACTION_MODE.PAN,
        deltaLength: 0.001
    }), true);
    assert.equal(shouldTranslateCameraForTargetDelta({
        userInteracting: true,
        interactionMode: INTERACTION_MODE.PINCH,
        deltaLength: 10
    }), false);
    assert.equal(shouldTranslateCameraForTargetDelta({
        userInteracting: false,
        interactionMode: INTERACTION_MODE.PAN,
        deltaLength: 10
    }), false);
});

test('applyPanTranslation translates only when interaction mode is pan', () => {
    const prevCamera = { x: 2, y: 3, z: 4 };
    const prevTarget = { x: -1, y: 0, z: 1 };
    const nextTarget = { x: 2, y: 4, z: 6 };
    const panResult = applyPanTranslation({
        prevCamera,
        prevTarget,
        nextTarget,
        userInteracting: true,
        interactionMode: INTERACTION_MODE.PAN
    });
    assert.equal(panResult.shouldTranslate, true);
    assert.deepEqual(panResult.nextCamera, { x: 5, y: 7, z: 9 });

    const pinchResult = applyPanTranslation({
        prevCamera,
        prevTarget,
        nextTarget,
        userInteracting: true,
        interactionMode: INTERACTION_MODE.PINCH
    });
    assert.equal(pinchResult.shouldTranslate, false);
    assert.deepEqual(pinchResult.nextCamera, prevCamera);
});

test('computeZoomedCameraDistance and computeTiltAngleFromDrag clamp safely', () => {
    assert.equal(computeZoomedCameraDistance({
        currentDistance: 5,
        minDistance: 0.6,
        maxDistance: 10
    }), 3.5999999999999996);
    assert.equal(computeZoomedCameraDistance({
        currentDistance: 0.61,
        minDistance: 0.6,
        maxDistance: 10
    }), 0.6);
    assert.equal(computeZoomedCameraDistance({
        currentDistance: 20,
        minDistance: 0.6,
        maxDistance: 10
    }), 10);
    assert.equal(computeTiltAngleFromDrag(3, { radiansPerPixel: 0.01 }), 0.03);
    assert.equal(computeTiltAngleFromDrag(999, { radiansPerPixel: 0.01, maxStep: 0.05 }), 0.05);
    assert.equal(computeTiltAngleFromDrag(-999, { radiansPerPixel: 0.01, maxStep: 0.05 }), -0.05);
});

test('installSafeControlsRefinement: touch mode transitions pan -> pinch -> pan -> none', () => {
    const { domElement, windowTarget, installResult } = createHarness();
    domElement.dispatch('pointerdown', makePointerEvent({ pointerType: 'touch', pointerId: 10 }));
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.PAN);
    domElement.dispatch('pointerdown', makePointerEvent({ pointerType: 'touch', pointerId: 11 }));
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.PINCH);
    windowTarget.dispatch('pointerup', makePointerEvent({ pointerType: 'touch', pointerId: 11 }));
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.PAN);
    windowTarget.dispatch('pointerup', makePointerEvent({ pointerType: 'touch', pointerId: 10 }));
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.NONE);
});

test('installSafeControlsRefinement: alt-left drag maps to orbit and resets to pan on release', () => {
    const { domElement, windowTarget, controls, MOUSE, installResult } = createHarness();
    domElement.dispatch('pointerdown', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 21,
        button: 0,
        altKey: true
    }));
    assert.equal(controls.mouseButtons.LEFT, MOUSE.ROTATE);
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.ORBIT);
    windowTarget.dispatch('pointerup', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 21,
        button: 0
    }));
    assert.equal(controls.mouseButtons.LEFT, MOUSE.PAN);
    assert.equal(installResult.getInteractionMode(), INTERACTION_MODE.NONE);
});

test('installSafeControlsRefinement: regular left pan does not call preventDefault', () => {
    const { domElement, controls } = createHarness();
    const panDownEvent = makePointerEvent({
        pointerType: 'mouse',
        pointerId: 44,
        button: 0,
        altKey: false,
        shiftKey: false
    });
    domElement.dispatch('pointerdown', panDownEvent);
    assert.equal(controls.enabled, true);
    assert.equal(panDownEvent.defaultPrevented, false);
    assert.equal(panDownEvent.propagationStopped, false);
});

test('installSafeControlsRefinement: shift-left drag uses custom tilt and prevents default only for tilt', () => {
    const { domElement, windowTarget, controls, getNavigateCalls } = createHarness();
    const shiftDownEvent = makePointerEvent({
        pointerType: 'mouse',
        pointerId: 7,
        button: 0,
        shiftKey: true,
        clientY: 100
    });
    domElement.dispatch('pointerdown', shiftDownEvent);
    assert.equal(controls.enabled, false);
    assert.equal(shiftDownEvent.defaultPrevented, true);
    assert.equal(shiftDownEvent.propagationStopped, true);

    const shiftMoveEvent = makePointerEvent({
        pointerType: 'mouse',
        pointerId: 7,
        clientY: 112
    });
    windowTarget.dispatch('pointermove', shiftMoveEvent);
    assert.equal(controls.rotateUpCalls.length, 1);
    assert.equal(controls.updateCalls > 0, true);
    assert.equal(getNavigateCalls(), 1);
    assert.equal(shiftMoveEvent.defaultPrevented, true);

    windowTarget.dispatch('pointerup', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 7,
        button: 0
    }));
    assert.equal(controls.enabled, true);
});

test('installSafeControlsRefinement: shift tilt fallback works when controls.rotateUp is unavailable', () => {
    const { domElement, windowTarget, controls, camera } = createHarness();
    controls.rotateUp = undefined;
    camera.position = new FakeVector3(0, 0, 5);
    controls.target = new FakeVector3(0, 0, 0);
    controls.minPolarAngle = 0.1;
    controls.maxPolarAngle = Math.PI - 0.1;

    domElement.dispatch('pointerdown', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 91,
        button: 0,
        shiftKey: true,
        clientY: 100
    }));
    windowTarget.dispatch('pointermove', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 91,
        clientY: 130
    }));
    assert.notEqual(camera.position.y, 0);
    assert.equal(controls.updateCalls > 0, true);
});

test('installSafeControlsRefinement: double click zooms camera toward target and honors min/max', () => {
    const { domElement, controls, camera, getNavigateCalls } = createHarness();
    camera.position = new FakeVector3(0, 0, 5);
    controls.target = new FakeVector3(0, 0, 0);

    const zoomEvent = makePointerEvent({ pointerType: 'mouse' });
    domElement.dispatch('dblclick', zoomEvent);
    approxEqual(camera.position.length(), 3.6, 1e-12);
    assert.equal(getNavigateCalls(), 1);
    assert.equal(zoomEvent.defaultPrevented, true);

    controls.minDistance = 3.6;
    const minClampEvent = makePointerEvent({ pointerType: 'mouse' });
    domElement.dispatch('dblclick', minClampEvent);
    approxEqual(camera.position.length(), 3.6, 1e-12);
    assert.equal(minClampEvent.defaultPrevented, false);
});

test('installSafeControlsRefinement: lot editor active bypasses control refinements', () => {
    const { domElement, windowTarget, controls, lotEditState, getNavigateCalls } = createHarness();
    lotEditState.active = true;

    const downEvent = makePointerEvent({
        pointerType: 'mouse',
        pointerId: 77,
        button: 0,
        shiftKey: true,
        clientY: 100
    });
    domElement.dispatch('pointerdown', downEvent);
    windowTarget.dispatch('pointermove', makePointerEvent({
        pointerType: 'mouse',
        pointerId: 77,
        clientY: 120
    }));
    domElement.dispatch('dblclick', makePointerEvent({ pointerType: 'mouse' }));

    assert.equal(controls.enabled, true);
    assert.equal(controls.rotateUpCalls.length, 0);
    assert.equal(getNavigateCalls(), 0);
});

test('pressure test: pan translation invariants hold across 50k random cases', () => {
    const rng = makeRng(7702130);
    const modes = [
        INTERACTION_MODE.PAN,
        INTERACTION_MODE.PINCH,
        INTERACTION_MODE.ORBIT,
        INTERACTION_MODE.DOLLY,
        INTERACTION_MODE.NONE
    ];
    for (let i = 0; i < 50000; i += 1) {
        const prevCamera = {
            x: randInRange(rng, -50, 50),
            y: randInRange(rng, -50, 50),
            z: randInRange(rng, -50, 50)
        };
        const prevTarget = {
            x: randInRange(rng, -50, 50),
            y: randInRange(rng, -50, 50),
            z: randInRange(rng, -50, 50)
        };
        const nextTarget = {
            x: prevTarget.x + randInRange(rng, -5, 5),
            y: prevTarget.y + randInRange(rng, -5, 5),
            z: prevTarget.z + randInRange(rng, -5, 5)
        };
        const interactionMode = modes[Math.floor(randInRange(rng, 0, modes.length))];
        const userInteracting = randInRange(rng, 0, 1) > 0.35;
        const result = applyPanTranslation({
            prevCamera,
            prevTarget,
            nextTarget,
            userInteracting,
            interactionMode
        });
        const dx = nextTarget.x - prevTarget.x;
        const dy = nextTarget.y - prevTarget.y;
        const dz = nextTarget.z - prevTarget.z;
        const deltaLength = Math.hypot(dx, dy, dz);
        const shouldTranslate = userInteracting && interactionMode === INTERACTION_MODE.PAN && deltaLength > 1e-8;
        if (shouldTranslate) {
            approxEqual(result.nextCamera.x, prevCamera.x + dx);
            approxEqual(result.nextCamera.y, prevCamera.y + dy);
            approxEqual(result.nextCamera.z, prevCamera.z + dz);
        } else {
            approxEqual(result.nextCamera.x, prevCamera.x);
            approxEqual(result.nextCamera.y, prevCamera.y);
            approxEqual(result.nextCamera.z, prevCamera.z);
        }
    }
});

test('pressure test: pinch mode never translates camera (sideways drift regression guard)', () => {
    const rng = makeRng(20260215);
    for (let i = 0; i < 30000; i += 1) {
        const prevCamera = {
            x: randInRange(rng, -100, 100),
            y: randInRange(rng, -100, 100),
            z: randInRange(rng, -100, 100)
        };
        const prevTarget = {
            x: randInRange(rng, -100, 100),
            y: randInRange(rng, -100, 100),
            z: randInRange(rng, -100, 100)
        };
        const nextTarget = {
            x: randInRange(rng, -100, 100),
            y: randInRange(rng, -100, 100),
            z: randInRange(rng, -100, 100)
        };
        const result = applyPanTranslation({
            prevCamera,
            prevTarget,
            nextTarget,
            userInteracting: true,
            interactionMode: INTERACTION_MODE.PINCH
        });
        assert.equal(result.shouldTranslate, false);
        approxEqual(result.nextCamera.x, prevCamera.x);
        approxEqual(result.nextCamera.y, prevCamera.y);
        approxEqual(result.nextCamera.z, prevCamera.z);
    }
});
