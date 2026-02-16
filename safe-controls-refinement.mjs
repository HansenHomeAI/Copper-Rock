export const INTERACTION_MODE = Object.freeze({
    NONE: 'none',
    PAN: 'pan',
    PINCH: 'pinch',
    ORBIT: 'orbit',
    DOLLY: 'dolly',
    TILT: 'tilt',
    OTHER: 'other'
});

export function isDesktopPointer(pointerType) {
    return pointerType !== 'touch' && pointerType !== 'pen';
}

export function resolveLeftMouseAction(event = {}) {
    return event.altKey ? 'rotate' : 'pan';
}

export function classifyPointerInteraction({
    pointerType = 'mouse',
    button = 0,
    altKey = false,
    shiftKey = false,
    activeTouchCount = 0
} = {}) {
    if (!isDesktopPointer(pointerType)) {
        return activeTouchCount >= 2 ? INTERACTION_MODE.PINCH : INTERACTION_MODE.PAN;
    }
    if (button === 0 && shiftKey) return INTERACTION_MODE.TILT;
    if (button === 0 && altKey) return INTERACTION_MODE.ORBIT;
    if (button === 0) return INTERACTION_MODE.PAN;
    if (button === 1) return INTERACTION_MODE.DOLLY;
    if (button === 2) return INTERACTION_MODE.ORBIT;
    return INTERACTION_MODE.OTHER;
}

export function shouldTranslateCameraForTargetDelta({
    userInteracting = false,
    interactionMode = INTERACTION_MODE.NONE,
    deltaLength = 0,
    epsilon = 1e-8
} = {}) {
    return Boolean(userInteracting) &&
        interactionMode === INTERACTION_MODE.PAN &&
        Number.isFinite(deltaLength) &&
        deltaLength > epsilon;
}

export function clamp(value, minValue, maxValue) {
    return Math.min(Math.max(value, minValue), maxValue);
}

export function computeZoomedCameraDistance({
    currentDistance,
    minDistance,
    maxDistance,
    zoomFactor = 0.72
} = {}) {
    if (!Number.isFinite(currentDistance) || currentDistance <= 0) return currentDistance;
    const lower = Number.isFinite(minDistance) ? minDistance : 0;
    const upper = Number.isFinite(maxDistance) ? Math.max(lower, maxDistance) : Number.POSITIVE_INFINITY;
    const nextDistance = currentDistance * zoomFactor;
    return clamp(nextDistance, lower, upper);
}

export function computeTiltAngleFromDrag(deltaY, {
    radiansPerPixel = 0.005,
    maxStep = 0.1
} = {}) {
    if (!Number.isFinite(deltaY) || !Number.isFinite(radiansPerPixel) || radiansPerPixel === 0) {
        return 0;
    }
    return clamp(deltaY * radiansPerPixel, -maxStep, maxStep);
}

export function applyPanTranslation({
    prevCamera,
    prevTarget,
    nextTarget,
    userInteracting = false,
    interactionMode = INTERACTION_MODE.NONE,
    epsilon = 1e-8
} = {}) {
    const delta = {
        x: nextTarget.x - prevTarget.x,
        y: nextTarget.y - prevTarget.y,
        z: nextTarget.z - prevTarget.z
    };
    const deltaLength = Math.hypot(delta.x, delta.y, delta.z);
    const shouldTranslate = shouldTranslateCameraForTargetDelta({
        userInteracting,
        interactionMode,
        deltaLength,
        epsilon
    });
    if (!shouldTranslate) {
        return {
            delta,
            deltaLength,
            shouldTranslate,
            nextCamera: { ...prevCamera }
        };
    }
    return {
        delta,
        deltaLength,
        shouldTranslate,
        nextCamera: {
            x: prevCamera.x + delta.x,
            y: prevCamera.y + delta.y,
            z: prevCamera.z + delta.z
        }
    };
}

export function installSafeControlsRefinement({
    windowTarget,
    domElement,
    controls,
    camera,
    lotEditState,
    MOUSE,
    Vector3,
    onUserNavigate
}) {
    if (!windowTarget || !domElement || !controls || !camera || !MOUSE || !Vector3) {
        throw new Error('installSafeControlsRefinement missing required dependencies.');
    }

    const state = {
        interactionMode: INTERACTION_MODE.NONE,
        touchPointerIds: new Set(),
        activeMousePointerId: null,
        shiftTilt: {
            active: false,
            pointerId: null,
            lastClientY: 0
        }
    };

    const emitUserNavigate = () => {
        if (typeof onUserNavigate === 'function') onUserNavigate();
    };

    const setLeftMouseBinding = (event) => {
        controls.mouseButtons.LEFT = resolveLeftMouseAction(event) === 'rotate'
            ? MOUSE.ROTATE
            : MOUSE.PAN;
    };

    const resetLeftMouseBinding = () => {
        controls.mouseButtons.LEFT = MOUSE.PAN;
    };

    const updateTouchInteractionMode = () => {
        if (state.touchPointerIds.size >= 2) {
            state.interactionMode = INTERACTION_MODE.PINCH;
            return;
        }
        state.interactionMode = state.touchPointerIds.size === 1
            ? INTERACTION_MODE.PAN
            : INTERACTION_MODE.NONE;
    };

    const endShiftTilt = (pointerId) => {
        if (!state.shiftTilt.active) return;
        if (pointerId !== undefined && pointerId !== null && pointerId !== state.shiftTilt.pointerId) return;
        state.shiftTilt.active = false;
        state.shiftTilt.pointerId = null;
        controls.enabled = true;
    };

    const handlePointerDown = (event) => {
        if (lotEditState && lotEditState.active) return;

        if (!isDesktopPointer(event.pointerType)) {
            state.touchPointerIds.add(event.pointerId);
            updateTouchInteractionMode();
            return;
        }

        state.interactionMode = classifyPointerInteraction({
            pointerType: event.pointerType,
            button: event.button,
            altKey: Boolean(event.altKey),
            shiftKey: Boolean(event.shiftKey),
            activeTouchCount: 0
        });

        if (event.button === 0) {
            state.activeMousePointerId = event.pointerId;
            setLeftMouseBinding(event);
        }

        if (state.interactionMode === INTERACTION_MODE.TILT) {
            state.shiftTilt.active = true;
            state.shiftTilt.pointerId = event.pointerId;
            state.shiftTilt.lastClientY = event.clientY;
            controls.enabled = false;
            event.preventDefault();
            event.stopPropagation();
        }
    };

    const handlePointerMove = (event) => {
        if (!state.shiftTilt.active) return;
        if (event.pointerId !== state.shiftTilt.pointerId) return;
        if (!isDesktopPointer(event.pointerType)) return;
        if (lotEditState && lotEditState.active) return;
        const deltaY = event.clientY - state.shiftTilt.lastClientY;
        state.shiftTilt.lastClientY = event.clientY;
        const rotateUpAmount = computeTiltAngleFromDrag(deltaY);
        if (Math.abs(rotateUpAmount) <= 1e-12) return;
        if (typeof controls.rotateUp === 'function') {
            controls.rotateUp(rotateUpAmount);
        } else {
            const offset = new Vector3().subVectors(camera.position, controls.target);
            const radius = offset.length();
            if (radius > 1e-8) {
                const azimuth = Math.atan2(offset.x, offset.z);
                const currentPolar = Math.acos(clamp(offset.y / radius, -1, 1));
                const minPolar = Number.isFinite(controls.minPolarAngle) ? controls.minPolarAngle : 0;
                const maxPolar = Number.isFinite(controls.maxPolarAngle) ? controls.maxPolarAngle : Math.PI;
                const nextPolar = clamp(currentPolar + rotateUpAmount, minPolar, maxPolar);
                const sinPolar = Math.sin(nextPolar);
                offset.x = radius * sinPolar * Math.sin(azimuth);
                offset.y = radius * Math.cos(nextPolar);
                offset.z = radius * sinPolar * Math.cos(azimuth);
                camera.position.copy(controls.target).add(offset);
            }
        }
        controls.update();
        emitUserNavigate();
        event.preventDefault();
    };

    const handlePointerUpOrCancel = (event) => {
        if (!isDesktopPointer(event.pointerType)) {
            state.touchPointerIds.delete(event.pointerId);
            updateTouchInteractionMode();
            return;
        }

        endShiftTilt(event.pointerId);
        if (event.pointerId === state.activeMousePointerId || event.button === 0) {
            state.activeMousePointerId = null;
            resetLeftMouseBinding();
        }
        state.interactionMode = INTERACTION_MODE.NONE;
    };

    const handleWindowBlur = () => {
        state.touchPointerIds.clear();
        endShiftTilt();
        state.activeMousePointerId = null;
        state.interactionMode = INTERACTION_MODE.NONE;
        resetLeftMouseBinding();
    };

    const handleDoubleClick = (event) => {
        if (lotEditState && lotEditState.active) return;
        if (!isDesktopPointer(event.pointerType)) return;
        const offset = new Vector3().subVectors(camera.position, controls.target);
        const currentDistance = offset.length();
        if (!(currentDistance > 1e-8)) return;
        const nextDistance = computeZoomedCameraDistance({
            currentDistance,
            minDistance: controls.minDistance,
            maxDistance: controls.maxDistance
        });
        if (Math.abs(nextDistance - currentDistance) <= 1e-8) return;
        offset.setLength(nextDistance);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        emitUserNavigate();
        event.preventDefault();
    };

    domElement.addEventListener('pointerdown', handlePointerDown, { passive: false, capture: true });
    windowTarget.addEventListener('pointermove', handlePointerMove, { passive: false, capture: true });
    windowTarget.addEventListener('pointerup', handlePointerUpOrCancel, { passive: true, capture: true });
    windowTarget.addEventListener('pointercancel', handlePointerUpOrCancel, { passive: true, capture: true });
    windowTarget.addEventListener('blur', handleWindowBlur);
    domElement.addEventListener('dblclick', handleDoubleClick, { passive: false, capture: true });

    resetLeftMouseBinding();

    return {
        getInteractionMode() {
            return state.interactionMode;
        },
        cleanup() {
            domElement.removeEventListener('pointerdown', handlePointerDown, { capture: true });
            windowTarget.removeEventListener('pointermove', handlePointerMove, { capture: true });
            windowTarget.removeEventListener('pointerup', handlePointerUpOrCancel, { capture: true });
            windowTarget.removeEventListener('pointercancel', handlePointerUpOrCancel, { capture: true });
            windowTarget.removeEventListener('blur', handleWindowBlur);
            domElement.removeEventListener('dblclick', handleDoubleClick, { capture: true });
        }
    };
}
