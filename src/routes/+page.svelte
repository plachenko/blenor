<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { TransformControls } from 'three/addons/controls/TransformControls.js';
	import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
	import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
	import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
	import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
	import { readModifiers, setMeshModifiers, shiftModifierBase } from '$lib/modifiers';
	import type { Modifier } from '$lib/modifiers';
	import { PaneGroup, Pane, PaneResizer } from 'paneforge';

	type PrimitiveKind = 'Box' | 'Sphere' | 'Cylinder' | 'Cone' | 'Plane' | 'Torus';
	type TransformTool = 'move' | 'rotate' | 'scale';
	type EditElement = 'face' | 'edge' | 'vert';
	type PaneSide = 'left' | 'right' | 'top' | 'bottom';
	const primitives: PrimitiveKind[] = ['Box', 'Sphere', 'Cylinder', 'Cone', 'Plane', 'Torus'];

	let viewport: HTMLElement;
	let webglUnavailable = $state(false);
	let menuOpen = $state(false);
	let objectSelected = $state(false);
	let cameraSelected = $state(false);
	let cameraFov = $state(48);
	let modifiersOpen = $state(false);
	let modifierStack = $state<Modifier[]>([]);
	let draggingModifierId = $state<string | null>(null);
	let modifierDropIndex = $state<number | null>(null);
	let modifierDrag: { id: string; pointerId: number; y: number; moved: boolean } | null = null;
	let reorderModifier: ((id: string, targetIndex: number) => void) | undefined;
	const onModifierDragDown = (event: PointerEvent, id: string) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		modifierDrag = { id, pointerId: event.pointerId, y: event.clientY, moved: false };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		event.preventDefault();
	};
	const onModifierDragMove = (event: PointerEvent) => {
		if (modifierDrag?.pointerId !== event.pointerId) return;
		if (!modifierDrag.moved && Math.abs(event.clientY - modifierDrag.y) < 5) return;
		modifierDrag.moved = true;
		draggingModifierId = modifierDrag.id;
		const panel = (event.currentTarget as HTMLElement).closest('.modifier-panel');
		const cards = [...(panel?.querySelectorAll<HTMLElement>('[data-modifier-id]') ?? [])]
			.filter((card) => card.dataset.modifierId !== modifierDrag?.id);
		const before = cards.findIndex((card) => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
		modifierDropIndex = before < 0 ? cards.length : before;
	};
	const onModifierDragUp = (event: PointerEvent) => {
		if (modifierDrag?.pointerId !== event.pointerId) return;
		if (modifierDrag.moved && modifierDropIndex !== null) reorderModifier?.(modifierDrag.id, modifierDropIndex);
		modifierDrag = null;
		draggingModifierId = null;
		modifierDropIndex = null;
	};
	const onModifierDragCancel = () => {
		modifierDrag = null;
		draggingModifierId = null;
		modifierDropIndex = null;
	};
	let paneLayout = $state<Record<PaneSide, number[]>>({ left: [], right: [], top: [], bottom: [] });
	let paneViews = $state<Record<number, 'inspector' | 'history'>>({});
	let inspectorVisible = $derived(Object.values(paneViews).includes('inspector'));
	let nextPaneId = 1;
	let paneMenuOpen = $state(false);
	let paneSwipePreview = $state<PaneSide | null>(null);
	let sceneItems = $state<{ index: number; name: string }[]>([]);
	let selectedSceneItem = $state<number | 'camera' | null>(null);
	let inspectorDetails = $state<{
		name: string; kind: string; position: number[]; rotation: number[]; scale: number[];
		fov?: number; modifiers?: number;
	} | null>(null);
	let selectFromPane: ((item: number | 'camera') => void) | undefined;
	let paneDrag: { id: number; x: number; y: number } | null = null;
	let ignorePaneClickUntil = 0;
	const addPane = (side: PaneSide, view: 'inspector' | 'history' = 'inspector') => {
		if (paneLayout[side].length >= 2) return;
		const id = nextPaneId++;
		paneLayout = { ...paneLayout, [side]: [...paneLayout[side], id] };
		paneViews = { ...paneViews, [id]: view };
		paneMenuOpen = false;
	};
	const closePane = (side: PaneSide, id: number) => {
		paneLayout = { ...paneLayout, [side]: paneLayout[side].filter((value) => value !== id) };
		delete paneViews[id];
	};
	const toggleInspector = () => {
		const existing = Object.entries(paneViews).find(([, view]) => view === 'inspector');
		if (existing) {
			const id = Number(existing[0]);
			const side = (['left', 'right', 'top', 'bottom'] as const).find((side) => paneLayout[side].includes(id));
			if (side) closePane(side, id);
			return;
		}
		const side = (['right', 'left', 'bottom', 'top'] as const).find((side) => paneLayout[side].length < 2);
		if (side) addPane(side, 'inspector');
		else {
			const id = Object.values(paneLayout).flat()[0];
			if (id !== undefined) paneViews = { ...paneViews, [id]: 'inspector' };
		}
	};
	const paneSwipeDirection = (dx: number, dy: number): PaneSide | null => {
		if (Math.hypot(dx, dy) < 18) return null;
		return Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'top' : 'bottom';
	};
	const onPaneTabDown = (event: PointerEvent) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		paneDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
		paneSwipePreview = null;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	};
	const onPaneTabMove = (event: PointerEvent) => {
		if (paneDrag?.id !== event.pointerId) return;
		paneSwipePreview = paneSwipeDirection(event.clientX - paneDrag.x, event.clientY - paneDrag.y);
	};
	const onPaneTabUp = (event: PointerEvent) => {
		if (paneDrag?.id !== event.pointerId) return;
		const dx = event.clientX - paneDrag.x;
		const dy = event.clientY - paneDrag.y;
		const side = Math.hypot(dx, dy) >= 45 ? paneSwipeDirection(dx, dy) : null;
		paneDrag = null;
		paneSwipePreview = null;
		if (side) {
			addPane(side);
			ignorePaneClickUntil = performance.now() + 300;
		}
	};
	const onPaneTabCancel = () => { paneDrag = null; paneSwipePreview = null; };
	let transformTool = $state<TransformTool | null>(null);
	let editMode = $state(false);
	let editElement = $state<EditElement>('face');
	let xray = $state(false);
	let editPartSelected = $state(false);
	let editGestureZone = $state<{ x: number; y: number; radius: number } | null>(null);
	let rotationLocked = $state(false);
	let fileMenuOpen = $state(false);
	let exportOptionsOpen = $state(false);
	let exportBusy = $state(false);
	let exportFormat = $state<'glb' | 'gltf'>('glb');
	let exportGodotAxes = $state(true);
	let exportSelectedOnly = $state(false);
	let exportIncludeCamera = $state(true);
	let exportTRS = $state(true);
	let exportName = $state('blenor-scene');
	let fileMessage = $state('');
	let cursorAxesOpen = $state(false);
	let cameraView = $state(false);
	let canUndo = $state(false);
	let canRedo = $state(false);
	let historyListOpen = $state(false);
	let historyEntries = $state<{ index: number; label: string }[]>([]);
	let historyCurrentIndex = $state(0);
	let fullscreenSupported = $state(false);
	let isFullscreen = $state(false);
	let projectInput: HTMLInputElement;
	let newProject: (() => void) | undefined;
	let saveProject: (() => void) | undefined;
	let openProject: ((file: File) => Promise<void>) | undefined;
	let exportScene: (() => Promise<void>) | undefined;
	let deleteSelectedObject: (() => void) | undefined;
	let addPrimitiveToScene: ((kind: PrimitiveKind) => void) | undefined;
	let setTransformTool: ((tool: TransformTool) => void) | undefined;
	let setEditElement: ((element: EditElement) => void) | undefined;
	let exitEditMode: (() => void) | undefined;
	let snapCursorToPart: (() => void) | undefined;
	let toggleXray: (() => void) | undefined;
	let setSceneCameraFromView: (() => void) | undefined;
	let toggleCameraView: (() => void) | undefined;
	let undoAction: (() => void) | undefined;
	let redoAction: (() => void) | undefined;
	let jumpToHistory: ((index: number) => void) | undefined;
	let toggleFullscreen: (() => Promise<void>) | undefined;
	let addModifier: ((type: Modifier['type']) => void) | undefined;
	let updateModifier: ((id: string, patch: Partial<Modifier>) => void) | undefined;
	let removeModifier: ((id: string) => void) | undefined;
	let toggleModifierExpanded: ((id: string) => void) | undefined;
	let applyModifierStack: (() => void) | undefined;

	onMount(() => {
		const scene = new THREE.Scene();
		const background = new THREE.Color('#171c24');
		scene.background = background;
		scene.fog = new THREE.FogExp2(background, 0.018);

		// Blender uses Z for height, so the grid lies on the XY plane.
		const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
		camera.up.set(0, 0, 1);
		camera.position.set(15, 15, 13);
		camera.lookAt(0, 0, 0);
		const sceneCamera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
		sceneCamera.name = 'Camera_1';
		sceneCamera.up.set(0, 0, 1);
		sceneCamera.position.set(8, -12, 8);
		sceneCamera.lookAt(0, 0, 0);
		scene.add(sceneCamera);
		const cameraPivotMaterial = new THREE.MeshBasicMaterial({ color: '#a9c4df', transparent: true,
			opacity: 0.55, depthTest: false, depthWrite: false });
		const cameraPivot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), cameraPivotMaterial);
		cameraPivot.name = 'camera-pivot';
		cameraPivot.renderOrder = 9;
		sceneCamera.add(cameraPivot);
		const fovHandleMaterial = new THREE.MeshBasicMaterial({ color: '#ffd783', depthTest: false, depthWrite: false });
		const fovHandle = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), fovHandleMaterial);
		fovHandle.name = 'fov-handle';
		fovHandle.visible = false;
		fovHandle.renderOrder = 9;
		sceneCamera.add(fovHandle);
		sceneCamera.updateMatrixWorld(true);
		const helperCamera = sceneCamera.clone();
		helperCamera.far = 3;
		helperCamera.updateProjectionMatrix();
		const cameraHelper = new THREE.CameraHelper(helperCamera);
		const helperMaterial = cameraHelper.material as THREE.LineBasicMaterial;
		helperMaterial.color.set('#8ca2b8');
		helperMaterial.transparent = true;
		helperMaterial.opacity = 0.28;
		helperMaterial.depthWrite = false;
		const updateCameraHelper = () => {
			sceneCamera.updateMatrixWorld(true);
			fovHandle.position.set(3 * Math.tan(THREE.MathUtils.degToRad(sceneCamera.fov / 2)) * sceneCamera.aspect, 0, -3);
			cameraFov = Math.round(sceneCamera.fov);
			helperCamera.position.copy(sceneCamera.position);
			helperCamera.quaternion.copy(sceneCamera.quaternion);
			helperCamera.fov = sceneCamera.fov;
			helperCamera.aspect = sceneCamera.aspect;
			helperCamera.updateProjectionMatrix();
			helperCamera.updateMatrixWorld(true);
			cameraHelper.update();
		};
		updateCameraHelper();
		scene.add(cameraHelper);

		const grid = new THREE.GridHelper(100, 100, '#647386', '#35404d');
		grid.rotation.x = Math.PI / 2;
		scene.add(grid);
		scene.add(new THREE.AmbientLight('#ffffff', 1.8));
		const light = new THREE.DirectionalLight('#ffffff', 2.4);
		light.position.set(8, 10, 14);
		scene.add(light);

		let renderer: THREE.WebGLRenderer;
		try {
			renderer = new THREE.WebGLRenderer({ antialias: true });
		} catch {
			webglUnavailable = true;
			grid.geometry.dispose();
			(grid.material as THREE.Material).dispose();
			return;
		}

		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		viewport.appendChild(renderer.domElement);
		fullscreenSupported = typeof viewport.requestFullscreen === 'function' &&
			typeof document.exitFullscreen === 'function';
		const syncFullscreen = () => { isFullscreen = document.fullscreenElement === viewport; };
		document.addEventListener('fullscreenchange', syncFullscreen);
		syncFullscreen();
		toggleFullscreen = async () => {
			if (!fullscreenSupported) return;
			try {
				if (document.fullscreenElement === viewport) await document.exitFullscreen();
				else await viewport.requestFullscreen();
			} catch {
				fileMessage = 'Fullscreen could not be opened';
			}
		};
		const canvas = renderer.domElement;
		const composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		const outlinePass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
		outlinePass.visibleEdgeColor.set('#ffe28a');
		outlinePass.hiddenEdgeColor.set('#000000');
		outlinePass.edgeStrength = 5;
		outlinePass.edgeThickness = 1.5;
		outlinePass.edgeGlow = 0;
		composer.addPass(outlinePass);
		const outputPass = new OutputPass();
		composer.addPass(outputPass);
		const controls = new OrbitControls(camera, canvas);
		controls.minDistance = 2;
		controls.maxDistance = 100;
		controls.minPolarAngle = 0.15;
		controls.maxPolarAngle = Math.PI / 2 - 0.01;
		const orbitView = { position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
		const transformControls = new TransformControls(camera, canvas);
		transformControls.detach();
		scene.add(transformControls.getHelper());

		const cursorPosition = new THREE.Vector3();
		const cursor = new THREE.Group();
		const cursorRed = new THREE.MeshBasicMaterial({ color: '#f27476', depthTest: false, depthWrite: false, side: THREE.DoubleSide });
		const cursorWhite = new THREE.MeshBasicMaterial({ color: '#f7f7f5', depthTest: false, depthWrite: false, side: THREE.DoubleSide });
		const cursorFill = new THREE.MeshBasicMaterial({ color: '#dbeeff', transparent: true, opacity: 0.10, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
		const cursorOutline = new THREE.MeshBasicMaterial({ color: '#dbeeff', transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
		cursor.add(new THREE.Mesh(new THREE.CircleGeometry(15.5, 48), cursorFill));
		cursor.add(new THREE.Mesh(new THREE.RingGeometry(14.7, 15.5, 48), cursorOutline));
		for (const [start, material] of [[0, cursorRed], [Math.PI, cursorWhite]] as const) {
			cursor.add(new THREE.Mesh(new THREE.RingGeometry(9, 10.5, 32, 1, start, Math.PI), material));
		}
		for (const [x, y, rotation, material] of [
			[-15, 0, 0, cursorWhite], [15, 0, 0, cursorRed],
			[0, -15, Math.PI / 2, cursorWhite], [0, 15, Math.PI / 2, cursorRed]
		] as const) {
			const mark = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.6), material);
			mark.position.set(x, y, 0);
			mark.rotation.z = rotation;
			cursor.add(mark);
		}
		cursor.traverse((child) => { child.renderOrder = 10; });
		scene.add(cursor);

		type Axis = 'x' | 'y' | 'z';
		type Selection = THREE.Mesh | THREE.PerspectiveCamera | 'cursor' | null;
		let selection: Selection = null;
		let handleProgress = 0;
		let handleTarget = 0;
		let animationFrame = 0;
		const gizmo = new THREE.Group();
		const axes = {
			x: new THREE.Vector3(1, 0, 0),
			y: new THREE.Vector3(0, 1, 0),
			z: new THREE.Vector3(0, 0, 1)
		};
		const axisColors = { x: '#f27476', y: '#80dca7', z: '#65aef2' };
		const handles = {} as Record<Axis, { line: THREE.Line; knob: THREE.Mesh; material: THREE.MeshBasicMaterial }>;
		for (const axis of ['x', 'y', 'z'] as const) {
			const line = new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), axes[axis]]),
				new THREE.LineBasicMaterial({ color: axisColors[axis], depthTest: false, depthWrite: false })
			);
			const material = new THREE.MeshBasicMaterial({ color: axisColors[axis], depthTest: false, depthWrite: false });
			const knob = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material);
			line.renderOrder = 11;
			knob.renderOrder = 11;
			gizmo.add(line, knob);
			handles[axis] = { line, knob, material };
		}
		scene.add(gizmo);
		const creationGuide = new THREE.Group();
		const guideLineMaterial = new THREE.LineBasicMaterial({ color: axisColors.z, depthTest: false, depthWrite: false });
		const guideKnobMaterial = new THREE.MeshBasicMaterial({ color: axisColors.z, depthTest: false, depthWrite: false });
		const guideLine = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]),
			guideLineMaterial
		);
		const guideKnob = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), guideKnobMaterial);
		guideLine.renderOrder = 12;
		guideKnob.renderOrder = 12;
		creationGuide.add(guideLine, guideKnob);
		creationGuide.visible = false;
		scene.add(creationGuide);
		const handleLengths = { x: 2, y: 2, z: 2 };
		const gizmoAnchor = new THREE.Vector3();
		let cursorHoldPointerId: number | null = null;
		let cursorHoldTimer = 0;
		const selectionPosition = () => selection === 'cursor' || !selection ? cursorPosition : selection.position;

		const projectToScreen = (point: THREE.Vector3) => {
			const rect = canvas.getBoundingClientRect();
			const projected = point.clone().project(camera);
			return {
				x: rect.left + (projected.x + 1) * rect.width / 2,
				y: rect.top + (1 - projected.y) * rect.height / 2
			};
		};
		let updateEditGestureZone: () => void = () => {};
		let lastInspectorSignature = '';
		const updateInspector = () => {
			const selected = selection instanceof THREE.Mesh || selection === sceneCamera ? selection : null;
			const details = selected ? {
				name: selected.name || (selected === sceneCamera ? 'Camera_1' : 'Mesh'),
				kind: selected === sceneCamera ? 'Perspective camera' : (selected as THREE.Mesh).geometry.type,
				position: selected.position.toArray().map((value) => Number(value.toFixed(2))),
				rotation: [selected.rotation.x, selected.rotation.y, selected.rotation.z]
					.map((value) => Number(THREE.MathUtils.radToDeg(value).toFixed(1))),
				scale: selected.scale.toArray().map((value) => Number(value.toFixed(2))),
				...(selected === sceneCamera ? { fov: Number(sceneCamera.fov.toFixed(1)) } :
					{ modifiers: readModifiers(selected as THREE.Mesh).length })
			} : null;
			const signature = JSON.stringify(details);
			if (signature !== lastInspectorSignature) {
				lastInspectorSignature = signature;
				inspectorDetails = details;
			}
		};
		const render = () => {
			cursor.position.copy(cursorPosition);
			cursor.quaternion.copy(camera.quaternion);
			if (selection === 'cursor' && cursorHoldPointerId === null) gizmoAnchor.copy(cursorPosition);
			gizmo.position.copy(gizmoAnchor);
			gizmo.visible = handleProgress > 0.001;
			const height = canvas.clientHeight;
			if (height) {
				const unitsPerPixel = 2 * camera.position.distanceTo(cursorPosition) *
					Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height;
				cursor.scale.setScalar(unitsPerPixel);
				const origin = gizmoAnchor;
				const base = projectToScreen(origin);
				const knobSize = 2 * camera.position.distanceTo(origin) *
					Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height * 7;
				for (const axis of ['x', 'y', 'z'] as const) {
					const unit = axes[axis];
					const endpoint = projectToScreen(origin.clone().add(unit));
					const pixelsPerUnit = Math.hypot(endpoint.x - base.x, endpoint.y - base.y);
					const length = THREE.MathUtils.clamp(58 / Math.max(4, pixelsPerUnit), 0.6, 12) * handleProgress;
					handleLengths[axis] = length;
					handles[axis].line.scale.setScalar(length);
					handles[axis].knob.position.copy(unit).multiplyScalar(length);
					handles[axis].knob.scale.setScalar(knobSize);
				}
			}
			updateEditGestureZone();
			updateInspector();
			composer.render();
		};
		let focusAnimationFrame = 0;
		const stopFocusAnimation = () => {
			if (focusAnimationFrame) cancelAnimationFrame(focusAnimationFrame);
			focusAnimationFrame = 0;
		};
		let commitHistory: (label?: string) => void = () => {};
		const resetSceneCamera = () => {
			sceneCamera.position.set(8, -12, 8);
			sceneCamera.lookAt(0, 0, 0);
			sceneCamera.fov = 48;
			sceneCamera.updateProjectionMatrix();
			sceneCamera.updateMatrixWorld(true);
			updateCameraHelper();
		};
		const leaveCameraView = () => {
			if (!cameraView) return;
			cameraView = false;
			camera.position.copy(orbitView.position);
			camera.fov = orbitView.fov;
			camera.updateProjectionMatrix();
			controls.target.copy(orbitView.target);
			controls.enabled = !transformControls.dragging;
			cameraHelper.visible = true;
			fovHandle.visible = cameraSelected;
			controls.update();
			render();
		};
		setSceneCameraFromView = () => {
			if (cameraView) return;
			sceneCamera.position.copy(camera.position);
			sceneCamera.quaternion.copy(camera.quaternion);
			sceneCamera.fov = camera.fov;
			sceneCamera.updateProjectionMatrix();
			sceneCamera.updateMatrixWorld(true);
			updateCameraHelper();
			fileMessage = 'Scene camera set to current view';
			commitHistory('Set camera from view');
			render();
		};
		toggleCameraView = () => {
			stopFocusAnimation();
			if (cameraView) {
				leaveCameraView();
				return;
			}
			orbitView.position.copy(camera.position);
			orbitView.target.copy(controls.target);
			orbitView.fov = camera.fov;
			camera.position.copy(sceneCamera.position);
			camera.quaternion.copy(sceneCamera.quaternion);
			camera.fov = sceneCamera.fov;
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld(true);
			cameraView = true;
			controls.enabled = false;
			cameraHelper.visible = false;
			fovHandle.visible = false;
			render();
		};
		const animateHandles = () => {
			const step = () => {
				handleProgress += (handleTarget - handleProgress) * 0.28;
				if (Math.abs(handleTarget - handleProgress) < 0.005) handleProgress = handleTarget;
				render();
				if (handleProgress !== handleTarget) animationFrame = requestAnimationFrame(step);
				else animationFrame = 0;
			};
			if (!animationFrame) animationFrame = requestAnimationFrame(step);
		};
		let editMesh: THREE.Mesh | null = null;
		let editHighlight: THREE.Object3D | null = null;
		const editHandle = new THREE.Object3D();
		scene.add(editHandle);
		let editRawIndices: number[] = [];
		let editRepresentativeIndices: number[] = [];
		let lastXrayFacePick: { x: number; y: number; time: number; index: number } | null = null;
		type EditSnapshot = {
			handleMatrix: THREE.Matrix4;
			positions: Map<number, THREE.Vector3>;
			highlightPositions: THREE.Vector3[];
			highlightCenter: THREE.Vector3;
		};
		let editDragSnapshot: EditSnapshot | null = null;
		let originalEditMaterial: {
			side: THREE.Side; transparent: boolean; opacity: number; depthWrite: boolean
		} | null = null;
		const touchPositions = new Map<number, THREE.Vector2>();
		let editTouchCandidateId: number | null = null;
		let editTouchCandidateStart: THREE.Vector2 | null = null;
		let editTouchCandidateAllowsDrag = false;
		let editGesture: {
			ids: [number, number]; distance: number; angle: number;
			center: THREE.Vector3; handleRotation: THREE.Quaternion;
			widthWeight: number; heightWeight: number; basis: THREE.Matrix4;
			snapshot: EditSnapshot;
		} | null = null;
		let editPartDrag: {
			id: number; plane: THREE.Plane; startPoint: THREE.Vector3;
			center: THREE.Vector3; snapshot: EditSnapshot;
		} | null = null;
		const clearEditHighlight = () => {
			editGesture = null;
			editPartDrag = null;
			editTouchCandidateId = null;
			editTouchCandidateStart = null;
			editTouchCandidateAllowsDrag = false;
			controls.enabled = !cameraView;
			transformControls.detach();
			transformTool = null;
			editDragSnapshot = null;
			editRawIndices = [];
			editRepresentativeIndices = [];
			editPartSelected = false;
			lastXrayFacePick = null;
			if (!editHighlight) return;
			editHighlight.parent?.remove(editHighlight);
			editHighlight.traverse((child) => {
				if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
					child.geometry.dispose();
					(child.material as THREE.Material).dispose();
				}
			});
			editHighlight = null;
		};
		const leaveEditMode = () => {
			clearEditHighlight();
			if (editMesh && originalEditMaterial) {
				const material = editMesh.material as THREE.MeshStandardMaterial;
				Object.assign(material, originalEditMaterial);
				material.needsUpdate = true;
			}
			originalEditMaterial = null;
			editMesh = null;
			editMode = false;
			editElement = 'face';
			xray = false;
			render();
		};
		exitEditMode = leaveEditMode;
		let syncModifierUI = () => {};
		const select = (next: Selection) => {
			if (selection === next) return;
			if (editMesh && next !== editMesh) leaveEditMode();
			transformControls.detach();
			transformTool = null;
			if (selection instanceof THREE.Mesh) {
				selection.getObjectByName('pivot')!.visible = false;
			}
			selection = next;
			syncModifierUI();
			objectSelected = selection instanceof THREE.Mesh;
			selectedSceneItem = selection === sceneCamera ? 'camera' :
				selection instanceof THREE.Mesh ? objects.indexOf(selection) : null;
			if (!objectSelected) modifiersOpen = false;
			cameraSelected = selection === sceneCamera;
			cameraPivotMaterial.opacity = cameraSelected ? 1 : 0.55;
			fovHandle.visible = cameraSelected && !cameraView;
			helperMaterial.opacity = cameraSelected ? 0.7 : 0.28;
			if (selection instanceof THREE.Mesh) {
				selection.getObjectByName('pivot')!.visible = true;
			}
			outlinePass.selectedObjects = selection instanceof THREE.Mesh ? [selection] : [];
			cursorFill.opacity = next === 'cursor' ? 0.22 : 0.10;
			cursorOutline.opacity = next === 'cursor' ? 0.9 : 0.45;
			handleTarget = next === 'cursor' ? 1 : 0;
			animateHandles();
			render();
		};
		const enterEditMode = (mesh: THREE.Mesh) => {
			if (Array.isArray(mesh.userData.modifiers) && mesh.userData.modifiers.length) {
				fileMessage = 'Apply the modifier stack before editing mesh parts';
				select(mesh);
				return;
			}
			select(mesh);
			clearEditHighlight();
			editMesh = mesh;
			const material = mesh.material as THREE.MeshStandardMaterial;
			originalEditMaterial = {
				side: material.side, transparent: material.transparent,
				opacity: material.opacity, depthWrite: material.depthWrite
			};
			editMode = true;
			editElement = 'face';
			xray = false;
			transformTool = null;
			transformControls.detach();
			render();
		};
		setEditElement = (element) => {
			editElement = element;
			clearEditHighlight();
			render();
		};
		toggleXray = () => {
			if (!editMesh || !originalEditMaterial) return;
			clearEditHighlight();
			xray = !xray;
			const material = editMesh.material as THREE.MeshStandardMaterial;
			material.side = xray ? THREE.DoubleSide : originalEditMaterial.side;
			material.transparent = xray || originalEditMaterial.transparent;
			material.opacity = xray ? 0.45 : originalEditMaterial.opacity;
			material.depthWrite = xray ? false : originalEditMaterial.depthWrite;
			material.needsUpdate = true;
			render();
		};
		snapCursorToPart = () => {
			if (!editMesh || editRepresentativeIndices.length === 0) return;
			const positions = editMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
			const center = new THREE.Vector3();
			for (const index of editRepresentativeIndices) center.add(new THREE.Vector3().fromBufferAttribute(positions, index));
			center.divideScalar(editRepresentativeIndices.length);
			editMesh.updateMatrixWorld(true);
			cursorPosition.copy(editMesh.localToWorld(center));
			commitHistory('Snap cursor to mesh');
			render();
		};
		setTransformTool = (tool) => {
			if (!(selection instanceof THREE.Mesh) && selection !== sceneCamera) return;
			if (selection === sceneCamera && tool === 'scale') return;
			if (editMode && (!editPartSelected || (editElement === 'vert' && tool !== 'move'))) return;
			transformTool = transformTool === tool ? null : tool;
			if (transformTool) {
				transformControls.setMode(transformTool === 'move' ? 'translate' : transformTool);
				transformControls.attach(editMode ? editHandle : selection);
			} else transformControls.detach();
			render();
		};
		controls.addEventListener('change', render);
		controls.addEventListener('start', stopFocusAnimation);
		transformControls.addEventListener('change', render);
		transformControls.addEventListener('dragging-changed', (event) => {
			controls.enabled = !event.value && !cameraView;
		});
		const raycaster = new THREE.Raycaster();
		const horizontalPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1));
		const planePoint = new THREE.Vector3();
		const screenPoint = new THREE.Vector2();
		const pointOnPlane = (clientX: number, clientY: number, z: number) => {
			const rect = canvas.getBoundingClientRect();
			screenPoint.set(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1
			);
			raycaster.setFromCamera(screenPoint, camera);
			horizontalPlane.constant = -z;
			return raycaster.ray.intersectPlane(horizontalPlane, planePoint) ? planePoint.clone() : null;
		};
		const objects: THREE.Mesh[] = [];
		const syncSceneItems = () => {
			sceneItems = objects.map((mesh, index) => ({ index, name: mesh.name || `Mesh_${index + 1}` }));
		};
		const focusInViewport = (target: THREE.Mesh | THREE.PerspectiveCamera) => {
			stopFocusAnimation();
			if (cameraView) leaveCameraView();
			const center = new THREE.Vector3();
			let radius = 2;
			if (target === sceneCamera) center.copy(sceneCamera.position);
			else {
				target.updateMatrixWorld(true);
				const bounds = new THREE.Box3().setFromObject(target);
				if (bounds.isEmpty()) center.copy(target.position);
				else {
					const sphere = bounds.getBoundingSphere(new THREE.Sphere());
					center.copy(sphere.center);
					radius = Math.max(0.2, sphere.radius);
				}
			}
			const direction = camera.position.clone().sub(controls.target);
			if (direction.lengthSq() < 0.0001) direction.set(1, 1, 1);
			direction.normalize();
			const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2);
			const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.2, camera.aspect));
			const distance = Math.max(4, radius * 1.25 / Math.sin(Math.min(halfVertical, halfHorizontal)));
			controls.maxDistance = Math.max(100, distance * 1.2);
			if (camera.far < distance + radius * 2) {
				camera.far = Math.max(200, distance + radius * 3);
				camera.updateProjectionMatrix();
			}
			const startPosition = camera.position.clone();
			const startTarget = controls.target.clone();
			const endPosition = center.clone().addScaledVector(direction, distance);
			const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320;
			const started = performance.now();
			const step = (now: number) => {
				const progress = duration ? Math.min(1, (now - started) / duration) : 1;
				const eased = 1 - (1 - progress) ** 3;
				camera.position.lerpVectors(startPosition, endPosition, eased);
				controls.target.lerpVectors(startTarget, center, eased);
				controls.update();
				render();
				focusAnimationFrame = progress < 1 ? requestAnimationFrame(step) : 0;
			};
			focusAnimationFrame = requestAnimationFrame(step);
		};
		selectFromPane = (item) => {
			const target = item === 'camera' ? sceneCamera : objects[item];
			if (!target) return;
			select(target);
			focusInViewport(target);
		};
		const pickSurface = (clientX: number, clientY: number) => {
			const rect = canvas.getBoundingClientRect();
			screenPoint.set(((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1);
			raycaster.setFromCamera(screenPoint, camera);
			return raycaster.intersectObjects(objects, false)[0];
		};
		const pickMesh = (clientX: number, clientY: number) =>
			pickSurface(clientX, clientY)?.object as THREE.Mesh | undefined;
		const pickCamera = (clientX: number, clientY: number) => {
			if (cameraView) return false;
			const rect = canvas.getBoundingClientRect();
			raycaster.setFromCamera(new THREE.Vector2(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1
			), camera);
			raycaster.params.Line.threshold = 0.17;
			return raycaster.intersectObject(cameraPivot, false).length > 0 ||
				raycaster.intersectObject(cameraHelper, false).length > 0;
		};
		type Triangle = { ids: [number, number, number]; normal: THREE.Vector3; plane: number };
		type TopologyEdge = { a: number; b: number; triangles: number[] };
		type Topology = {
			vertices: THREE.Vector3[]; sourceIndices: number[][]; triangles: Triangle[];
			edges: TopologyEdge[]; edgesByKey: Map<string, TopologyEdge>
		};
		const topologyCache = new WeakMap<THREE.BufferGeometry, Topology>();
		const topologyFor = (geometry: THREE.BufferGeometry): Topology => {
			const cached = topologyCache.get(geometry);
			if (cached) return cached;
			const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
			const indices = geometry.getIndex();
			const vertices: THREE.Vector3[] = [];
			const sourceIndices: number[][] = [];
			const vertexIds = new Map<string, number>();
			const triangles: Triangle[] = [];
			const edgesByKey = new Map<string, TopologyEdge>();
			const vertexId = (index: number) => {
				const point = new THREE.Vector3().fromBufferAttribute(positions, index);
				const key = [point.x, point.y, point.z].map((value) => Math.round(value * 10000)).join(',');
				let id = vertexIds.get(key);
				if (id === undefined) {
					id = vertices.length;
					vertices.push(point);
					sourceIndices.push([]);
					vertexIds.set(key, id);
				}
				if (!sourceIndices[id].includes(index)) sourceIndices[id].push(index);
				return id;
			};
			const count = indices ? indices.count : positions.count;
			for (let i = 0; i + 2 < count; i += 3) {
				const ids = [0, 1, 2].map((offset) => vertexId(indices ? indices.getX(i + offset) : i + offset)) as [number, number, number];
				const a = vertices[ids[0]];
				const b = vertices[ids[1]];
				const c = vertices[ids[2]];
				const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
				triangles.push({ ids, normal, plane: normal.dot(a) });
				for (const [u, v] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
					const key = [Math.min(u, v), Math.max(u, v)].join(':');
					let edge = edgesByKey.get(key);
					if (!edge) {
						edge = { a: Math.min(u, v), b: Math.max(u, v), triangles: [] };
						edgesByKey.set(key, edge);
					}
					edge.triangles.push(triangles.length - 1);
				}
			}
			const topology = { vertices, sourceIndices, triangles, edges: [...edgesByKey.values()], edgesByKey };
			topologyCache.set(geometry, topology);
			return topology;
		};
		const setEditHighlight = (highlight: THREE.Object3D, vertexIds: number[], topology: Topology) => {
			const facePick = lastXrayFacePick;
			clearEditHighlight();
			lastXrayFacePick = facePick;
			editRepresentativeIndices = vertexIds.map((id) => topology.sourceIndices[id][0]);
			editRawIndices = [...new Set(vertexIds.flatMap((id) => topology.sourceIndices[id]))];
			editPartSelected = true;
			const center = new THREE.Vector3();
			for (const id of vertexIds) center.add(topology.vertices[id]);
			center.divideScalar(vertexIds.length);
			editMesh!.updateMatrixWorld(true);
			editHandle.position.copy(editMesh!.localToWorld(center));
			editHandle.quaternion.copy(editMesh!.getWorldQuaternion(new THREE.Quaternion()));
			editHandle.scale.set(1, 1, 1);
			editHighlight = highlight;
			editHighlight.renderOrder = 15;
			editMesh!.add(highlight);
			render();
		};
		const isVisiblePoint = (point: THREE.Vector3) => {
			const projected = point.clone().project(camera);
			if (projected.z < -1 || projected.z > 1) return false;
			if (xray) return true;
			raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
			const nearest = raycaster.intersectObjects(objects, false)[0];
			return !nearest || nearest.distance >= camera.position.distanceTo(point) - 0.005;
		};
		const gestureZoneForMesh = () => {
			if (!editMesh || !editPartSelected || editElement === 'vert') return null;
			const geometry = editMesh.geometry;
			if (!geometry.boundingBox) geometry.computeBoundingBox();
			const box = geometry.boundingBox;
			if (!box) return null;
			editMesh.updateMatrixWorld(true);
			const centerWorld = editMesh.localToWorld(box.getCenter(new THREE.Vector3()));
			if (centerWorld.clone().applyMatrix4(camera.matrixWorldInverse).z >= -camera.near) return null;
			const centerScreen = projectToScreen(centerWorld);
			let objectRadius = 0;
			for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y])
				for (const z of [box.min.z, box.max.z]) {
					const corner = projectToScreen(editMesh.localToWorld(new THREE.Vector3(x, y, z)));
					objectRadius = Math.max(objectRadius, Math.hypot(corner.x - centerScreen.x, corner.y - centerScreen.y));
				}
			const rect = viewport.getBoundingClientRect();
			return {
				x: centerScreen.x - rect.left, y: centerScreen.y - rect.top,
				radius: Math.min(Math.max(objectRadius + 56, 84), Math.max(100, Math.hypot(rect.width, rect.height) * 0.55))
			};
		};
		updateEditGestureZone = () => {
			const next = gestureZoneForMesh();
			if ((!next && !editGestureZone) || (next && editGestureZone &&
				Math.abs(next.x - editGestureZone.x) < 0.5 && Math.abs(next.y - editGestureZone.y) < 0.5 &&
				Math.abs(next.radius - editGestureZone.radius) < 0.5)) return;
			editGestureZone = next;
		};
		const touchOnSelectedPart = (clientX: number, clientY: number) => {
			if (!editMesh || !editHighlight || !editPartSelected) return false;
			if (transformTool && transformControls.object === editHandle) {
				const rect = canvas.getBoundingClientRect();
				transformControls.pointerHover({
					x: ((clientX - rect.left) / rect.width) * 2 - 1,
					y: -((clientY - rect.top) / rect.height) * 2 + 1,
					button: 0
				} as PointerEvent);
				if (transformControls.axis) return true;
			}
			const center = projectToScreen(editHandle.position);
			if (Math.hypot(clientX - center.x, clientY - center.y) < (editElement === 'vert' ? 26 : 56)) return true;
			if (editElement === 'vert') return false;
			const rect = canvas.getBoundingClientRect();
			raycaster.setFromCamera(new THREE.Vector2(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1
			), camera);
			if (editElement === 'face' && editHighlight instanceof THREE.Mesh) {
				const hit = raycaster.intersectObject(editHighlight, false)[0];
				return !!hit && isVisiblePoint(hit.point);
			}
			if (editElement === 'edge' && editHighlight instanceof THREE.LineSegments) {
				const positions = editHighlight.geometry.getAttribute('position') as THREE.BufferAttribute;
				const a = projectToScreen(editHighlight.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, 0)));
				const b = projectToScreen(editHighlight.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, 1)));
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const t = THREE.MathUtils.clamp(((clientX - a.x) * dx + (clientY - a.y) * dy) /
					Math.max(0.001, dx * dx + dy * dy), 0, 1);
				return Math.hypot(clientX - a.x - t * dx, clientY - a.y - t * dy) < 24;
			}
			return false;
		};
		const pickEditElement = (clientX: number, clientY: number) => {
			if (!editMesh) return false;
			const mesh = editMesh;
			const topology = topologyFor(mesh.geometry);
			mesh.updateMatrixWorld(true);
			const rect = canvas.getBoundingClientRect();
			screenPoint.set(((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1);
			raycaster.setFromCamera(screenPoint, camera);
			const meshHits = raycaster.intersectObject(mesh, false);
			const frontHit = raycaster.intersectObjects(objects, false)[0];
			if (editElement === 'face') {
				if (!xray && frontHit?.object !== mesh) return false;
				let hit = meshHits[0];
				if (xray && meshHits.length > 1) {
					const now = performance.now();
					const repeat = lastXrayFacePick && now - lastXrayFacePick.time < 700 &&
						Math.hypot(clientX - lastXrayFacePick.x, clientY - lastXrayFacePick.y) < 14;
					const index = repeat ? (lastXrayFacePick!.index + 1) % meshHits.length : 0;
					lastXrayFacePick = { x: clientX, y: clientY, time: now, index };
					hit = meshHits[index];
				}
				if (hit?.faceIndex == null) return false;
				const chosen = topology.triangles[hit.faceIndex];
				if (!chosen) return false;
				cursorPosition.copy(hit.point);
				const connected = new Set<number>([hit.faceIndex]);
				const pending = [hit.faceIndex];
				while (pending.length) {
					const index = pending.pop()!;
					const ids = topology.triangles[index].ids;
					for (const [u, v] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
						const edge = topology.edgesByKey.get([Math.min(u, v), Math.max(u, v)].join(':'));
						for (const neighbor of edge?.triangles ?? []) {
							const triangle = topology.triangles[neighbor];
							if (!connected.has(neighbor) && triangle.normal.dot(chosen.normal) > 0.99999 &&
								Math.abs(triangle.plane - chosen.plane) < 0.0001) {
								connected.add(neighbor);
								pending.push(neighbor);
							}
						}
					}
				}
				const points: number[] = [];
				for (const index of connected) for (const id of topology.triangles[index].ids) {
					const point = topology.vertices[id];
					points.push(point.x, point.y, point.z);
				}
				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
				setEditHighlight(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
					color: '#ffe28a', side: THREE.DoubleSide, transparent: true, opacity: 0.42,
					depthTest: false, depthWrite: false
				})), [...new Set([...connected].flatMap((index) => topology.triangles[index].ids))], topology);
				return true;
			}
			if (editElement === 'vert') {
				let closest = -1;
				let distance = 14;
				for (let i = 0; i < topology.vertices.length; i++) {
					const world = mesh.localToWorld(topology.vertices[i].clone());
					const screen = projectToScreen(world);
					const next = Math.hypot(clientX - screen.x, clientY - screen.y);
					if (next < distance && isVisiblePoint(world)) { closest = i; distance = next; }
				}
				if (closest < 0) return false;
				cursorPosition.copy(mesh.localToWorld(topology.vertices[closest].clone()));
				const marker = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8),
					new THREE.MeshBasicMaterial({ color: '#ffe28a', depthTest: false, depthWrite: false }));
				marker.position.copy(topology.vertices[closest]);
				setEditHighlight(marker, [closest], topology);
				return true;
			}
			let closest: TopologyEdge | null = null;
			let distance = 12;
			for (const edge of topology.edges) {
				if (edge.triangles.length > 1 && edge.triangles.every((index) =>
					topology.triangles[index].normal.dot(topology.triangles[edge.triangles[0]].normal) > 0.99999)) continue;
				const worldA = mesh.localToWorld(topology.vertices[edge.a].clone());
				const worldB = mesh.localToWorld(topology.vertices[edge.b].clone());
				const a = projectToScreen(worldA);
				const b = projectToScreen(worldB);
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const t = THREE.MathUtils.clamp(((clientX - a.x) * dx + (clientY - a.y) * dy) /
					Math.max(0.001, dx * dx + dy * dy), 0, 1);
				const next = Math.hypot(clientX - a.x - dx * t, clientY - a.y - dy * t);
				if (next < distance && isVisiblePoint(worldA.clone().lerp(worldB, t))) {
					closest = edge;
					distance = next;
				}
			}
			if (!closest) return false;
			cursorPosition.copy(topology.vertices[closest.a]).add(topology.vertices[closest.b]).multiplyScalar(0.5);
			mesh.localToWorld(cursorPosition);
			const geometry = new THREE.BufferGeometry().setFromPoints([
				topology.vertices[closest.a], topology.vertices[closest.b]
			]);
			setEditHighlight(new THREE.LineSegments(geometry,
				new THREE.LineBasicMaterial({ color: '#ffe28a', depthTest: false, depthWrite: false })),
				[closest.a, closest.b], topology);
			return true;
		};
		const captureEditSnapshot = () => {
			if (!editMesh || !editRawIndices.length) return null;
			editHandle.updateMatrixWorld(true);
			const positions = editMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
			const saved = new Map<number, THREE.Vector3>();
			for (const index of editRawIndices) saved.set(index, new THREE.Vector3().fromBufferAttribute(positions, index));
			const highlightPositions: THREE.Vector3[] = [];
			if (editHighlight instanceof THREE.Mesh || editHighlight instanceof THREE.LineSegments) {
				const attribute = editHighlight.geometry.getAttribute('position') as THREE.BufferAttribute;
				for (let i = 0; i < attribute.count; i++) highlightPositions.push(new THREE.Vector3().fromBufferAttribute(attribute, i));
			}
			return {
				handleMatrix: editHandle.matrixWorld.clone(), positions: saved, highlightPositions,
				highlightCenter: editHighlight?.position.clone() ?? new THREE.Vector3()
			};
		};
		const applyEditDelta = (localDelta: THREE.Matrix4, snapshot: EditSnapshot) => {
			if (!editMesh) return;
			const geometry = editMesh.geometry;
			const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
			for (const [index, original] of snapshot.positions) {
				const point = original.clone().applyMatrix4(localDelta);
				attribute.setXYZ(index, point.x, point.y, point.z);
			}
			attribute.needsUpdate = true;
			geometry.computeVertexNormals();
			geometry.computeBoundingBox();
			geometry.computeBoundingSphere();
			topologyCache.delete(geometry);
			if (editHighlight instanceof THREE.Mesh && editElement === 'vert') {
				editHighlight.position.copy(snapshot.highlightCenter).applyMatrix4(localDelta);
			} else if (editHighlight instanceof THREE.Mesh || editHighlight instanceof THREE.LineSegments) {
				const overlay = editHighlight.geometry.getAttribute('position') as THREE.BufferAttribute;
				for (let i = 0; i < overlay.count; i++) {
					const point = snapshot.highlightPositions[i].clone().applyMatrix4(localDelta);
					overlay.setXYZ(i, point.x, point.y, point.z);
				}
				overlay.needsUpdate = true;
			}
		};
		transformControls.addEventListener('mouseDown', () => {
			if (transformControls.object === editHandle) editDragSnapshot = captureEditSnapshot();
		});
		transformControls.addEventListener('objectChange', () => {
			if (editMesh && transformControls.object === editHandle && editDragSnapshot) {
				editMesh.updateMatrixWorld(true);
				editHandle.updateMatrixWorld(true);
				const localDelta = editMesh.matrixWorld.clone().invert()
					.multiply(editHandle.matrixWorld)
					.multiply(editDragSnapshot.handleMatrix.clone().invert())
					.multiply(editMesh.matrixWorld);
				applyEditDelta(localDelta, editDragSnapshot);
			} else if (selection instanceof THREE.Mesh) {
				const pivot = selection.getObjectByName('pivot') as THREE.Mesh;
				pivot.scale.set(
					1 / Math.max(0.001, Math.abs(selection.scale.x)),
					1 / Math.max(0.001, Math.abs(selection.scale.y)),
					1 / Math.max(0.001, Math.abs(selection.scale.z))
				);
			} else if (transformControls.object === sceneCamera) {
				updateCameraHelper();
			}
			render();
		});
		transformControls.addEventListener('mouseUp', () => {
			if (transformControls.object === editHandle) {
				editDragSnapshot = null;
				editHandle.scale.set(1, 1, 1);
				render();
			}
			commitHistory();
		});
		const axisAt = (clientX: number, clientY: number): Axis | null => {
			if (selection !== 'cursor' || handleProgress < 0.2) return null;
			const origin = selectionPosition();
			const a = projectToScreen(origin);
			let nearest: Axis | null = null;
			let nearestDistance = Infinity;
			for (const axis of ['x', 'y', 'z'] as const) {
				const b = projectToScreen(origin.clone().addScaledVector(axes[axis], handleLengths[axis]));
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const t = THREE.MathUtils.clamp(((clientX - a.x) * dx + (clientY - a.y) * dy) / (dx * dx + dy * dy), 0.35, 1.15);
				const distance = Math.hypot(clientX - a.x - t * dx, clientY - a.y - t * dy);
				if (distance < 13 && distance < nearestDistance) {
					nearest = axis;
					nearestDistance = distance;
				}
			}
			return nearest;
		};
		type Drag = {
			id: number;
			mode: 'plane' | Axis;
			target: Exclude<Selection, null>;
			origin: THREE.Vector3;
			offset: THREE.Vector3;
			startX: number;
			startY: number;
			axisX: number;
			axisY: number;
		};
		let drag: Drag | null = null;
		let objectScaleDrag: {
			id: number; mesh: THREE.Mesh; startX: number; startY: number;
			directionX: number; directionY: number;
			pivot: THREE.Vector3; position: THREE.Vector3; scale: THREE.Vector3;
		} | null = null;
		let createDrag: {
			id: number; mesh: THREE.Mesh; origin: THREE.Vector3; startX: number; startY: number;
			axis: Axis; direction: number; screenX: number; screenY: number; orbitTracked: boolean
		} | null = null;
		let pointerStart: { id: number; x: number; y: number; target: Selection; mode: 'plane' | Axis } | null = null;
		let fovDrag: { id: number; startX: number; fov: number } | null = null;
		let lastMeshTap: { mesh: THREE.Mesh; time: number; x: number; y: number } | null = null;
		const cancelCursorHoldTimer = () => {
			if (cursorHoldTimer) window.clearTimeout(cursorHoldTimer);
			cursorHoldTimer = 0;
		};
		const closeCursorHold = (creating = false) => {
			cancelCursorHoldTimer();
			if (cursorHoldPointerId === null) return;
			cursorHoldPointerId = null;
			cursorAxesOpen = false;
			handleTarget = creating ? 0 : selection === 'cursor' ? 1 : 0;
			cursorFill.opacity = selection === 'cursor' ? 0.22 : 0.10;
			cursorOutline.opacity = selection === 'cursor' ? 0.9 : 0.45;
			animateHandles();
		};
		const activePointers = new Set<number>();
		const editTouchIds = new Set<number>();
		const pointOnEditPlane = (clientX: number, clientY: number, plane: THREE.Plane) => {
			const rect = canvas.getBoundingClientRect();
			raycaster.setFromCamera(new THREE.Vector2(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1
			), camera);
			return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
		};
		const beginEditPartDrag = (id: number) => {
			if (!editMesh || !editTouchCandidateStart) return;
			const center = editHandle.position.clone();
			const normal = camera.getWorldDirection(new THREE.Vector3());
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
			const startPoint = pointOnEditPlane(editTouchCandidateStart.x, editTouchCandidateStart.y, plane);
			const snapshot = captureEditSnapshot();
			if (startPoint && snapshot) editPartDrag = { id, plane, startPoint, center, snapshot };
		};
		const updateEditPartDrag = (clientX: number, clientY: number) => {
			if (!editPartDrag || !editMesh) return;
			const point = pointOnEditPlane(clientX, clientY, editPartDrag.plane);
			if (!point) return;
			const offset = point.sub(editPartDrag.startPoint);
			const worldDelta = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
			editMesh.updateMatrixWorld(true);
			const localDelta = editMesh.matrixWorld.clone().invert().multiply(worldDelta).multiply(editMesh.matrixWorld);
			applyEditDelta(localDelta, editPartDrag.snapshot);
			editHandle.position.copy(editPartDrag.center).add(offset);
			render();
		};
		const updateEditGesture = () => {
			if (!editGesture || !editMesh) return;
			const [first, second] = editGesture.ids.map((id) => touchPositions.get(id));
			if (!first || !second) return;
			const dx = second.x - first.x;
			const dy = second.y - first.y;
			const pinch = THREE.MathUtils.clamp(Math.hypot(dx, dy) / editGesture.distance, 0.05, 20);
			const widthScale = Math.pow(pinch, editGesture.widthWeight);
			const heightScale = Math.pow(pinch, editGesture.heightWeight);
			const angle = rotationLocked ? 0 : Math.atan2(dy, dx) - editGesture.angle;
			const rotation = new THREE.Quaternion().setFromAxisAngle(camera.getWorldDirection(new THREE.Vector3()), angle);
			const worldDelta = new THREE.Matrix4().makeTranslation(editGesture.center.x, editGesture.center.y, editGesture.center.z)
				.multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
				.multiply(editGesture.basis)
				.multiply(new THREE.Matrix4().makeScale(widthScale, heightScale, 1))
				.multiply(editGesture.basis.clone().invert())
				.multiply(new THREE.Matrix4().makeTranslation(-editGesture.center.x, -editGesture.center.y, -editGesture.center.z));
			editMesh.updateMatrixWorld(true);
			const localDelta = editMesh.matrixWorld.clone().invert().multiply(worldDelta).multiply(editMesh.matrixWorld);
			applyEditDelta(localDelta, editGesture.snapshot);
			editHandle.quaternion.copy(rotation.multiply(editGesture.handleRotation));
			render();
		};
		const beginEditGesture = (secondId: number) => {
			if (editTouchCandidateId === null || !editMesh) return false;
			const firstId = editTouchCandidateId;
			const first = touchPositions.get(firstId);
			const second = touchPositions.get(secondId);
			editPartDrag = null;
			const snapshot = captureEditSnapshot();
			if (!first || !second || !snapshot) return false;
			const dx = second.x - first.x;
			const dy = second.y - first.y;
			const directionLengthSquared = dx * dx + dy * dy;
			const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
			const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
			const cameraBack = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
			let width = cameraRight;
			let height = cameraUp;
			let depth = cameraBack;
			if (editElement === 'face' && editHighlight instanceof THREE.Mesh) {
				editMesh.updateMatrixWorld(true);
				const positions = editHighlight.geometry.getAttribute('position') as THREE.BufferAttribute;
				const a = editHighlight.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, 0));
				const b = editHighlight.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, 1));
				const c = editHighlight.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, 2));
				const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
				if (normal.lengthSq() > 0.5) {
					width = cameraRight.clone().addScaledVector(normal, -cameraRight.dot(normal));
					if (width.lengthSq() < 0.0001) width = cameraUp.clone().addScaledVector(normal, -cameraUp.dot(normal));
					width.normalize();
					height = new THREE.Vector3().crossVectors(normal, width).normalize();
					if (height.dot(cameraUp) < 0) height.negate();
					depth = new THREE.Vector3().crossVectors(width, height).normalize();
				}
			}
			editGesture = {
				ids: [firstId, secondId], distance: Math.max(8, Math.hypot(dx, dy)),
				angle: Math.atan2(dy, dx), center: editHandle.position.clone(),
				handleRotation: editHandle.quaternion.clone(),
				widthWeight: directionLengthSquared < 64 ? 0.5 : dx * dx / directionLengthSquared,
				heightWeight: directionLengthSquared < 64 ? 0.5 : dy * dy / directionLengthSquared,
				basis: new THREE.Matrix4().makeBasis(width, height, depth), snapshot
			};
			editTouchCandidateId = null;
			editTouchCandidateStart = null;
			editTouchCandidateAllowsDrag = false;
			editTouchIds.add(secondId);
			pointerStart = null;
			controls.enabled = false;
			return true;
		};
		const chooseCreationAxis = (origin: THREE.Vector3, dx: number, dy: number) => {
			const base = projectToScreen(origin);
			const gestureLength = Math.hypot(dx, dy);
			let best: { axis: Axis; direction: number; screenX: number; screenY: number; score: number } | null = null;
			for (const axis of ['x', 'y', 'z'] as const) {
				const endpoint = projectToScreen(origin.clone().add(axes[axis]));
				const sx = endpoint.x - base.x;
				const sy = endpoint.y - base.y;
				const screenLength = Math.hypot(sx, sy);
				if (screenLength < 0.001) continue;
				const screenX = sx / screenLength;
				const screenY = sy / screenLength;
				const dot = (dx * screenX + dy * screenY) / gestureLength;
				const score = Math.abs(dot);
				if (!best || score > best.score) best = {
					axis, direction: dot >= 0 ? 1 : -1, screenX: screenX * Math.sign(dot || 1),
					screenY: screenY * Math.sign(dot || 1), score
				};
			}
			return best!;
		};
		const updateCreation = (event: PointerEvent) => {
			if (!createDrag || event.pointerId !== createDrag.id) return;
			const { origin, axis, direction, screenX, screenY } = createDrag;
			const base = projectToScreen(origin);
			const travel = Math.max(0,
				(event.clientX - createDrag.startX) * screenX + (event.clientY - createDrag.startY) * screenY
			);
			let low = 0.05;
			let high = 50;
			for (let i = 0; i < 16; i++) {
				const middle = (low + high) / 2;
				const face = projectToScreen(origin.clone().addScaledVector(axes[axis], direction * middle));
				const projectedTravel = (face.x - base.x) * screenX + (face.y - base.y) * screenY;
				if (projectedTravel < travel) low = middle;
				else high = middle;
			}
			const extent = travel < 1 ? 0.05 : high;
			const sideAxes = (['x', 'y', 'z'] as const).filter((candidate) => candidate !== axis);
			const sideScreenX = -screenY;
			const sideScreenY = screenX;
			const lateralRate = sideAxes.reduce((rate, candidate) => {
				const endpoint = projectToScreen(origin.clone().add(axes[candidate]));
				return rate + Math.abs(
					(endpoint.x - base.x) * sideScreenX + (endpoint.y - base.y) * sideScreenY
				);
			}, 0);
			const lateralTravel = Math.abs(
				(event.clientX - createDrag.startX) * sideScreenX +
				(event.clientY - createDrag.startY) * sideScreenY
			);
			const lateralExtent = THREE.MathUtils.clamp(
				lateralTravel / Math.max(1, lateralRate), 0.05, 50
			);
			createDrag.mesh.scale.set(lateralExtent, lateralExtent, lateralExtent);
			createDrag.mesh.scale[axis] = extent / 2;
			const pivot = createDrag.mesh.getObjectByName('pivot') as THREE.Mesh;
			pivot.scale.set(1 / lateralExtent, 1 / lateralExtent, 1 / lateralExtent);
			pivot.scale[axis] = 2 / extent;
			cursorPosition.copy(origin).addScaledVector(axes[axis], direction * extent);
			createDrag.mesh.position.copy(cursorPosition);
			creationGuide.position.copy(origin);
			creationGuide.quaternion.setFromUnitVectors(
				axes.z, axes[axis].clone().multiplyScalar(direction)
			);
			creationGuide.visible = true;
			guideLineMaterial.color.set(axisColors[axis]);
			guideKnobMaterial.color.set(axisColors[axis]);
			guideLine.scale.z = extent;
			guideKnob.position.z = extent;
			guideKnob.scale.setScalar(2 * camera.position.distanceTo(cursorPosition) *
				Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, canvas.clientHeight) * 7);
			render();
		};
		const beginCursorCreation = (start: NonNullable<typeof pointerStart>, event: PointerEvent) => {
			const origin = cursorPosition.clone();
			const chosen = chooseCreationAxis(origin, event.clientX - start.x, event.clientY - start.y);
			const mesh = createPrimitive('Box', false);
			mesh.geometry.translate(
				chosen.axis === 'x' ? -chosen.direction : 0,
				chosen.axis === 'y' ? -chosen.direction : 0,
				chosen.axis === 'z' ? -chosen.direction : 0
			);
			createDrag = {
				id: event.pointerId, mesh, origin,
				startX: start.x, startY: start.y,
				axis: chosen.axis, direction: chosen.direction,
				screenX: chosen.screenX, screenY: chosen.screenY,
				orbitTracked: start.target instanceof THREE.Mesh
			};
			updateCreation(event);
			closeCursorHold(true);
		};
		const updateDrag = (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.id) return;
			const position = drag.target === 'cursor' ? cursorPosition : drag.target.position;
			if (drag.mode === 'plane') {
				if (drag.target === 'cursor') {
					const surface = pickSurface(event.clientX, event.clientY);
					if (surface) {
						cursorPosition.copy(surface.point);
						const planePoint = pointOnPlane(event.clientX, event.clientY, cursorPosition.z);
						if (planePoint) drag.offset.copy(planePoint).sub(cursorPosition);
						render();
						return;
					}
				}
				const point = pointOnPlane(event.clientX, event.clientY,
					drag.target === 'cursor' ? cursorPosition.z : drag.origin.z);
				if (point) {
					position.copy(point.sub(drag.offset));
					position.x = THREE.MathUtils.clamp(position.x, -50, 50);
					position.y = THREE.MathUtils.clamp(position.y, -50, 50);
				}
			} else {
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				const axisLengthSquared = drag.axisX ** 2 + drag.axisY ** 2;
				const amount = (dx * drag.axisX + dy * drag.axisY) / Math.max(axisLengthSquared, 0.001);
				position.copy(drag.origin).addScaledVector(axes[drag.mode], amount);
				position[drag.mode] = THREE.MathUtils.clamp(position[drag.mode], -50, 50);
			}
			if (drag.target === sceneCamera) updateCameraHelper();
			render();
		};
		const updateFovDrag = (clientX: number, clientY: number) => {
			if (!fovDrag) return;
			const rect = canvas.getBoundingClientRect();
			raycaster.setFromCamera(new THREE.Vector2(
				((clientX - rect.left) / rect.width) * 2 - 1,
				-((clientY - rect.top) / rect.height) * 2 + 1
			), camera);
			const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sceneCamera.quaternion);
			const point = sceneCamera.localToWorld(new THREE.Vector3(0, 0, -3));
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
			const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
			const degrees = hit ? THREE.MathUtils.radToDeg(2 * Math.atan(
				Math.max(0.001, sceneCamera.worldToLocal(hit).x) / (3 * sceneCamera.aspect)
			)) : fovDrag.fov + (clientX - fovDrag.startX) * 0.25;
			sceneCamera.fov = THREE.MathUtils.clamp(degrees, 10, 120);
			sceneCamera.updateProjectionMatrix();
			updateCameraHelper();
			render();
		};
		const updateObjectScale = (clientX: number, clientY: number) => {
			if (!objectScaleDrag) return;
			const state = objectScaleDrag;
			const travel = (clientX - state.startX) * state.directionX +
				(clientY - state.startY) * state.directionY;
			const factor = THREE.MathUtils.clamp(Math.exp(travel / 140), 0.05, 20);
			state.mesh.scale.copy(state.scale).multiplyScalar(factor);
			state.mesh.position.copy(state.position).sub(state.pivot).multiplyScalar(factor).add(state.pivot);
			const pivotMarker = state.mesh.getObjectByName('pivot') as THREE.Mesh;
			pivotMarker.scale.set(
				1 / Math.max(0.001, Math.abs(state.mesh.scale.x)),
				1 / Math.max(0.001, Math.abs(state.mesh.scale.y)),
				1 / Math.max(0.001, Math.abs(state.mesh.scale.z))
			);
			render();
		};
		const beginObjectScale = (start: NonNullable<typeof pointerStart>) => {
			if (!(start.target instanceof THREE.Mesh)) return;
			cancelCursorHoldTimer();
			select(start.target);
			start.target.updateMatrixWorld(true);
			const localPivot = start.target.worldToLocal(cursorPosition.clone());
			start.target.geometry.translate(-localPivot.x, -localPivot.y, -localPivot.z);
			if (readModifiers(start.target).length) {
				shiftModifierBase(start.target, localPivot.clone().negate());
				setMeshModifiers(start.target, readModifiers(start.target));
			}
			start.target.position.copy(cursorPosition);
			start.target.updateMatrixWorld(true);
			topologyCache.delete(start.target.geometry);
			const cursorScreen = projectToScreen(cursorPosition);
			let directionX = start.x - cursorScreen.x;
			let directionY = start.y - cursorScreen.y;
			const length = Math.hypot(directionX, directionY);
			if (length < 10) { directionX = 0; directionY = -1; }
			else { directionX /= length; directionY /= length; }
			objectScaleDrag = {
				id: start.id, mesh: start.target, startX: start.x, startY: start.y,
				directionX, directionY, pivot: cursorPosition.clone(),
				position: start.target.position.clone(), scale: start.target.scale.clone()
			};
		};
		const onPointerDown = (event: PointerEvent) => {
			stopFocusAnimation();
			if (event.pointerType === 'mouse' && event.button !== 0) return;
			activePointers.add(event.pointerId);
			if (event.pointerType === 'touch') {
				touchPositions.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
				if (editGesture || beginEditGesture(event.pointerId)) {
					editTouchIds.add(event.pointerId);
					canvas.setPointerCapture(event.pointerId);
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
				const onPart = activePointers.size === 1 && touchOnSelectedPart(event.clientX, event.clientY);
				const zone = !onPart && activePointers.size === 1 ? gestureZoneForMesh() : null;
				const rect = viewport.getBoundingClientRect();
				const inZone = !!zone && Math.hypot(event.clientX - rect.left - zone.x,
					event.clientY - rect.top - zone.y) <= zone.radius;
				if (onPart || inZone) {
					editTouchCandidateId = event.pointerId;
					editTouchCandidateStart = new THREE.Vector2(event.clientX, event.clientY);
					editTouchCandidateAllowsDrag = onPart;
					editTouchIds.add(event.pointerId);
					pointerStart = null;
					canvas.setPointerCapture(event.pointerId);
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
			}
			if (activePointers.size > 1) {
				fovDrag = null;
				controls.enabled = !cameraView;
				closeCursorHold();
				objectScaleDrag = null;
				pointerStart = null;
				return;
			}
			const projectedFovHandle = fovHandle.getWorldPosition(new THREE.Vector3()).project(camera);
			if (cameraSelected && !cameraView && projectedFovHandle.z > -1 && projectedFovHandle.z < 1 &&
				Math.hypot(event.clientX - projectToScreen(fovHandle.getWorldPosition(new THREE.Vector3())).x,
					event.clientY - projectToScreen(fovHandle.getWorldPosition(new THREE.Vector3())).y) <= 20) {
				fovDrag = { id: event.pointerId, startX: event.clientX, fov: sceneCamera.fov };
				canvas.setPointerCapture(event.pointerId);
				controls.enabled = false;
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			const cursorScreen = projectToScreen(cursorPosition);
			const nearCursor = Math.hypot(event.clientX - cursorScreen.x, event.clientY - cursorScreen.y) <= 17;
			if (transformTool && (selection instanceof THREE.Mesh || selection === sceneCamera) && !(nearCursor && !editMesh)) {
				const rect = canvas.getBoundingClientRect();
				transformControls.pointerHover({
					x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
					y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
					button: event.button
				} as PointerEvent);
				if (transformControls.axis) {
					pointerStart = null;
					controls.enabled = false;
					return;
				}
			}
			if (activePointers.size > 1 || drag || createDrag) {
				pointerStart = null;
				if (drag || createDrag) event.stopImmediatePropagation();
				return;
			}
			const axis = axisAt(event.clientX, event.clientY);
			const hitMesh = pickMesh(event.clientX, event.clientY);
			const xrayHitsEditMesh = !!(editMesh && xray && raycaster.intersectObject(editMesh, false).length);
			const target = axis ? selection : xrayHitsEditMesh ? editMesh : hitMesh && hitMesh === selection ? hitMesh :
				nearCursor ? 'cursor' : hitMesh ?? (pickCamera(event.clientX, event.clientY) ? sceneCamera : null);
			pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, target, mode: axis ?? 'plane' };
			if (nearCursor && !editMesh) {
				cancelCursorHoldTimer();
				const id = event.pointerId;
				cursorHoldTimer = window.setTimeout(() => {
					cursorHoldTimer = 0;
					if (pointerStart?.id !== id || activePointers.size !== 1 || drag || createDrag) return;
					cursorHoldPointerId = id;
					cursorAxesOpen = true;
					gizmoAnchor.copy(cursorPosition);
					handleTarget = 1;
					cursorFill.opacity = 0.22;
					cursorOutline.opacity = 0.9;
					animateHandles();
				}, 420);
			}
			if (target && !(event.pointerType === 'touch' && target instanceof THREE.Mesh)) {
				canvas.setPointerCapture(event.pointerId);
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};
		const onPointerMove = (event: PointerEvent) => {
			if (fovDrag?.id === event.pointerId) {
				updateFovDrag(event.clientX, event.clientY);
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (editTouchIds.has(event.pointerId)) {
				touchPositions.get(event.pointerId)?.set(event.clientX, event.clientY);
				if (editGesture) updateEditGesture();
				else if (editTouchCandidateId === event.pointerId && editTouchCandidateAllowsDrag) {
					if (!editPartDrag && editTouchCandidateStart &&
						editTouchCandidateStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) {
						beginEditPartDrag(event.pointerId);
					}
					updateEditPartDrag(event.clientX, event.clientY);
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (cursorHoldPointerId === event.pointerId) {
				if (pointerStart?.id === event.pointerId &&
					Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 12) {
					const start = pointerStart;
					pointerStart = null;
					beginCursorCreation(start, event);
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (objectScaleDrag?.id === event.pointerId) {
				updateObjectScale(event.clientX, event.clientY);
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (!editMesh && event.pointerType === 'touch' && activePointers.size === 1 &&
				pointerStart?.id === event.pointerId && pointerStart.target instanceof THREE.Mesh) {
				if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >
					(cursorHoldTimer ? 12 : 5)) {
					beginObjectScale(pointerStart);
					pointerStart = null;
					updateObjectScale(event.clientX, event.clientY);
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (createDrag?.id === event.pointerId) {
				updateCreation(event);
				event.stopImmediatePropagation();
			} else if (drag?.id === event.pointerId) {
				updateDrag(event);
				event.stopImmediatePropagation();
			} else if (pointerStart?.id === event.pointerId &&
				Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) >
				(pointerStart.target === 'cursor' && (!selection || cursorHoldTimer) ? 12 : 5)) {
				const start = pointerStart;
				pointerStart = null;
				cancelCursorHoldTimer();
				if (!start.target) return;
				if (start.target === 'cursor' && !selection) {
					beginCursorCreation(start, event);
					event.stopImmediatePropagation();
					return;
				}
				if (start.target instanceof THREE.Mesh) {
					if (event.pointerType !== 'touch') {
						select(start.target);
						event.stopImmediatePropagation();
					}
					return;
				}
				if (start.target === sceneCamera) {
					select(sceneCamera);
					const origin = sceneCamera.position.clone();
					drag = {
						id: event.pointerId, mode: 'plane', target: sceneCamera, origin,
						offset: pointOnPlane(start.x, start.y, origin.z)?.sub(origin) ?? new THREE.Vector3(),
						startX: start.x, startY: start.y, axisX: 0, axisY: 0
					};
					updateDrag(event);
					event.stopImmediatePropagation();
					return;
				}
				select(start.target);
				const origin = cursorPosition.clone();
				const base = projectToScreen(origin);
				const unit = start.mode === 'plane' ? null : projectToScreen(origin.clone().add(axes[start.mode]));
				drag = {
					id: event.pointerId, mode: start.mode, target: start.target, origin,
					offset: pointOnPlane(start.x, start.y, origin.z)?.sub(origin) ?? new THREE.Vector3(),
					startX: start.x, startY: start.y,
					axisX: unit ? unit.x - base.x : 0, axisY: unit ? unit.y - base.y : 0
				};
				updateDrag(event);
				event.stopImmediatePropagation();
			}
		};
		const finishPointerUp = (event: PointerEvent) => {
			activePointers.delete(event.pointerId);
			touchPositions.delete(event.pointerId);
			if (fovDrag?.id === event.pointerId) {
				updateFovDrag(event.clientX, event.clientY);
				fovDrag = null;
				controls.enabled = !cameraView;
				event.stopImmediatePropagation();
				return;
			}
			if (cursorHoldPointerId === event.pointerId) {
				const orbitTracked = pointerStart?.target instanceof THREE.Mesh;
				closeCursorHold();
				pointerStart = null;
				if (!orbitTracked) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
				return;
			}
			if (pointerStart?.id === event.pointerId) cancelCursorHoldTimer();
			if (objectScaleDrag?.id === event.pointerId) {
				updateObjectScale(event.clientX, event.clientY);
				objectScaleDrag = null;
				pointerStart = null;
				return;
			}
			if (editTouchIds.delete(event.pointerId)) {
				const finishedPartDrag = editPartDrag?.id === event.pointerId;
				if (finishedPartDrag) {
					updateEditPartDrag(event.clientX, event.clientY);
					editPartDrag = null;
				}
				if (!finishedPartDrag && editTouchCandidateAllowsDrag &&
					editTouchCandidateId === event.pointerId && editTouchCandidateStart &&
					editTouchCandidateStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) < 8) {
					const surface = pickSurface(event.clientX, event.clientY);
					if (surface?.object === editMesh) {
						cursorPosition.copy(surface.point);
					}
					pickEditElement(event.clientX, event.clientY);
					render();
				}
				if (editGesture?.ids.includes(event.pointerId)) editGesture = null;
				if (editTouchCandidateId === event.pointerId) {
					editTouchCandidateId = null;
					editTouchCandidateAllowsDrag = false;
				}
				if (editTouchCandidateId === null) editTouchCandidateStart = null;
				if (!editTouchIds.size) controls.enabled = !cameraView;
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			if (!transformControls.dragging) controls.enabled = !cameraView;
			if (createDrag?.id === event.pointerId) {
				const orbitTracked = createDrag.orbitTracked;
				updateCreation(event);
				createDrag = null;
				creationGuide.visible = false;
				pointerStart = null;
				select(null);
				render();
				if (!orbitTracked) event.stopImmediatePropagation();
			} else if (drag?.id === event.pointerId) {
				updateDrag(event);
				drag = null;
				pointerStart = null;
				event.stopImmediatePropagation();
			} else if (pointerStart?.id === event.pointerId) {
				const target = pointerStart.target;
				const handled = !!target;
				const orbitTrackedTouch = event.pointerType === 'touch' && target instanceof THREE.Mesh;
				if (target instanceof THREE.Mesh) {
					const surface = pickSurface(event.clientX, event.clientY);
					if (surface?.object === target) {
						cursorPosition.copy(surface.point);
						render();
					}
				}
				if (editMesh) {
					// Projected edges and vertices can sit just outside the mesh silhouette.
					const pickedPart = target === editMesh
						? pickEditElement(event.clientX, event.clientY)
						: editElement !== 'face' && pickEditElement(event.clientX, event.clientY);
					if (!pickedPart && target instanceof THREE.Mesh && target !== editMesh) {
						leaveEditMode();
						select(target);
					} else if (!pickedPart && target !== editMesh) {
						leaveEditMode();
						select(target === sceneCamera ? sceneCamera : null);
					}
					lastMeshTap = null;
				} else if (target instanceof THREE.Mesh) {
					const now = performance.now();
					const doubleTap = lastMeshTap?.mesh === target && now - lastMeshTap.time < 350 &&
						Math.hypot(event.clientX - lastMeshTap.x, event.clientY - lastMeshTap.y) < 24;
					if (doubleTap) {
						lastMeshTap = null;
						enterEditMode(target);
						pickEditElement(event.clientX, event.clientY);
					} else {
						lastMeshTap = { mesh: target, time: now, x: event.clientX, y: event.clientY };
						select(selection === target ? null : target);
					}
				} else if (target) {
					lastMeshTap = null;
					select(selection === target && pointerStart.mode === 'plane' ? null : target);
				} else {
					lastMeshTap = null;
					select(null);
					const point = pointOnPlane(event.clientX, event.clientY, 0);
					if (point && Math.abs(point.x) <= 50 && Math.abs(point.y) <= 50) cursorPosition.copy(point);
					render();
				}
				pointerStart = null;
				if (handled && !orbitTrackedTouch) event.stopImmediatePropagation();
			}
		};
		const onPointerUp = (event: PointerEvent) => {
			finishPointerUp(event);
			if (!activePointers.size) commitHistory();
		};
		const finishPointerCancel = (event: PointerEvent) => {
			activePointers.delete(event.pointerId);
			touchPositions.delete(event.pointerId);
			if (fovDrag?.id === event.pointerId) {
				fovDrag = null;
				controls.enabled = !cameraView;
				event.stopImmediatePropagation();
				return;
			}
			if (cursorHoldPointerId === event.pointerId) closeCursorHold();
			if (pointerStart?.id === event.pointerId) cancelCursorHoldTimer();
			if (objectScaleDrag?.id === event.pointerId) objectScaleDrag = null;
			if (editTouchIds.delete(event.pointerId)) {
				if (editPartDrag?.id === event.pointerId) editPartDrag = null;
				if (editGesture?.ids.includes(event.pointerId)) editGesture = null;
				if (editTouchCandidateId === event.pointerId) {
					editTouchCandidateId = null;
					editTouchCandidateAllowsDrag = false;
				}
				if (editTouchCandidateId === null) editTouchCandidateStart = null;
				if (!editTouchIds.size) controls.enabled = !cameraView;
				event.stopImmediatePropagation();
				return;
			}
			controls.enabled = !cameraView;
			if (createDrag?.id === event.pointerId) {
				createDrag = null;
				creationGuide.visible = false;
				render();
			}
			if (drag?.id === event.pointerId) drag = null;
			if (pointerStart?.id === event.pointerId) pointerStart = null;
		};
		const onPointerCancel = (event: PointerEvent) => {
			finishPointerCancel(event);
			if (!activePointers.size) commitHistory();
		};
		canvas.addEventListener('pointerdown', onPointerDown, true);
		canvas.addEventListener('pointermove', onPointerMove, true);
		canvas.addEventListener('pointerup', onPointerUp, true);
		canvas.addEventListener('pointercancel', onPointerCancel, true);
		const onContextMenu = (event: MouseEvent) => event.preventDefault();
		canvas.addEventListener('contextmenu', onContextMenu);

		const createPrimitive = (kind: PrimitiveKind, shouldSelect = true) => {
			let geometry: THREE.BufferGeometry;
			switch (kind) {
				case 'Box': geometry = new THREE.BoxGeometry(2, 2, 2); break;
				case 'Sphere': geometry = new THREE.SphereGeometry(1, 32, 20); break;
				case 'Cylinder': geometry = new THREE.CylinderGeometry(1, 1, 2, 32); break;
				case 'Cone': geometry = new THREE.ConeGeometry(1, 2, 32); break;
				case 'Plane': geometry = new THREE.PlaneGeometry(2.5, 2.5); break;
				case 'Torus': geometry = new THREE.TorusGeometry(1, 0.3, 16, 48); break;
			}
			const material = new THREE.MeshStandardMaterial({
				color: '#8fb9ed', roughness: 0.55, metalness: 0.12,
				side: kind === 'Plane' ? THREE.DoubleSide : THREE.FrontSide
			});
			const mesh = new THREE.Mesh(geometry, material);
			mesh.name = `${kind}_${objects.length + 1}`;
			geometry.center();
			geometry.computeBoundingBox();
			if (kind === 'Cylinder' || kind === 'Cone') mesh.rotation.x = Math.PI / 2;
			mesh.position.copy(cursorPosition);
			const pivot = new THREE.Mesh(
				new THREE.SphereGeometry(0.075, 12, 8),
				new THREE.MeshBasicMaterial({ color: '#ffe5a8', depthTest: false, depthWrite: false })
			);
			pivot.name = 'pivot';
			pivot.visible = false;
			pivot.renderOrder = 12;
			mesh.add(pivot);
			scene.add(mesh);
			objects.push(mesh);
			syncSceneItems();
			if (shouldSelect) select(mesh);
			menuOpen = false;
			render();
			return mesh;
		};
		addPrimitiveToScene = (kind) => { createPrimitive(kind); commitHistory(`Add ${kind}`); };

		const download = (blob: Blob, filename: string) => {
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			document.body.append(link);
			link.click();
			link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		};
		const projectName = () => exportName.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.(glb|gltf|json)$/i, '') || 'blenor-scene';
		const copyForFile = (object: THREE.Mesh, index: number) => {
			const copy = object.clone(false);
			copy.geometry = object.geometry.clone();
			const material = (object.material as THREE.MeshStandardMaterial).clone();
			if (object === editMesh && originalEditMaterial) Object.assign(material, originalEditMaterial);
			copy.material = material;
			copy.name = object.name || `Mesh_${index + 1}`;
			return copy;
		};
		const fileScene = (source: THREE.Mesh[]) => {
			const group = new THREE.Group();
			group.name = 'BlenorScene';
			for (const [index, object] of source.entries()) group.add(copyForFile(object, index));
			group.updateMatrixWorld(true);
			return group;
		};
		const disposeFileScene = (group: THREE.Group) => {
			for (const child of group.children) {
				if (!(child instanceof THREE.Mesh)) continue;
				const mesh = child;
				mesh.geometry.dispose();
				const material = mesh.material;
				if (Array.isArray(material)) material.forEach((item) => item.dispose());
				else material.dispose();
			}
		};
		const disposeObject = (object: THREE.Mesh) => {
			const pivot = object.getObjectByName('pivot') as THREE.Mesh | undefined;
			if (pivot) {
				pivot.geometry.dispose();
				(pivot.material as THREE.Material).dispose();
			}
			object.geometry.dispose();
			(object.material as THREE.Material).dispose();
		};
		const addLiveMesh = (mesh: THREE.Mesh) => {
			const pivot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8),
				new THREE.MeshBasicMaterial({ color: '#ffe5a8', depthTest: false, depthWrite: false }));
			pivot.name = 'pivot';
			pivot.visible = false;
			pivot.renderOrder = 12;
			pivot.scale.set(
				1 / Math.max(0.001, Math.abs(mesh.scale.x)),
				1 / Math.max(0.001, Math.abs(mesh.scale.y)),
				1 / Math.max(0.001, Math.abs(mesh.scale.z))
			);
			mesh.add(pivot);
			scene.add(mesh);
			objects.push(mesh);
			syncSceneItems();
		};
		type HistoryState = {
			meshes: THREE.Mesh[]; cursor: THREE.Vector3; selectedIndex: number;
			cameraSelected: boolean;
			editing: boolean; editElement: EditElement;
			cameraPosition: THREE.Vector3; cameraRotation: THREE.Quaternion; cameraFov: number;
			signature: string; label: string;
		};
		const history: HistoryState[] = [];
		let historyIndex = -1;
		const historySignature = () => JSON.stringify({
			cursor: cursorPosition.toArray(),
			camera: [sceneCamera.position.toArray(), sceneCamera.quaternion.toArray(), sceneCamera.fov],
			meshes: objects.map((mesh) => ({
				name: mesh.name, position: mesh.position.toArray(), quaternion: mesh.quaternion.toArray(),
				scale: mesh.scale.toArray(), vertices: Array.from(mesh.geometry.getAttribute('position').array),
				modifiers: readModifiers(mesh).map(({ id, type, axis, enabled, count, spacing }) =>
					({ id, type, axis, enabled, count, spacing }))
			}))
		});
		const captureHistory = (signature = historySignature(), label = 'Scene start'): HistoryState => ({
			meshes: objects.map(copyForFile), cursor: cursorPosition.clone(),
			selectedIndex: selection instanceof THREE.Mesh ? objects.indexOf(selection) : -1,
			cameraSelected: selection === sceneCamera,
			editing: editMode, editElement,
			cameraPosition: sceneCamera.position.clone(), cameraRotation: sceneCamera.quaternion.clone(),
			cameraFov: sceneCamera.fov, signature, label
		});
		const disposeHistory = (state: HistoryState) => {
			for (const mesh of state.meshes) disposeObject(mesh);
		};
		const syncHistoryButtons = () => {
			canUndo = historyIndex > 0;
			canRedo = historyIndex < history.length - 1;
			historyCurrentIndex = historyIndex;
			historyEntries = history.map((state, index) => ({ index, label: state.label }));
		};
		const resetHistory = (label = 'Scene start') => {
			for (const state of history.splice(0)) disposeHistory(state);
			history.push(captureHistory(historySignature(), label));
			historyIndex = 0;
			syncHistoryButtons();
		};
		const describeHistoryChange = (previous: HistoryState): string => {
			if (objects.length > previous.meshes.length) return objects.length - previous.meshes.length === 1
				? `Add ${objects[objects.length - 1].name}` : `Add ${objects.length - previous.meshes.length} objects`;
			if (objects.length < previous.meshes.length) return 'Delete object';
			if (Math.abs(sceneCamera.fov - previous.cameraFov) > 0.001) return 'Change camera FOV';
			if (sceneCamera.position.distanceToSquared(previous.cameraPosition) > 1e-10 ||
				sceneCamera.quaternion.angleTo(previous.cameraRotation) > 1e-5) return 'Transform camera';
			for (let index = 0; index < objects.length; index++) {
				const mesh = objects[index];
				const before = previous.meshes[index];
				const currentPositions = mesh.geometry.getAttribute('position').array;
				const oldPositions = before.geometry.getAttribute('position').array;
				if (currentPositions.length !== oldPositions.length ||
					Array.from(currentPositions).some((value, position) => value !== oldPositions[position])) return `Edit ${mesh.name}`;
				if (mesh.position.distanceToSquared(before.position) > 1e-10 ||
					mesh.quaternion.angleTo(before.quaternion) > 1e-5 ||
					mesh.scale.distanceToSquared(before.scale) > 1e-10) return `Transform ${mesh.name}`;
			}
			if (cursorPosition.distanceToSquared(previous.cursor) > 1e-10) return 'Move cursor';
			return 'Edit scene';
		};
		commitHistory = (label) => {
			const signature = historySignature();
			if (history[historyIndex]?.signature === signature) return;
			const description = label ?? (history[historyIndex] ? describeHistoryChange(history[historyIndex]) : 'Edit scene');
			for (const state of history.splice(historyIndex + 1)) disposeHistory(state);
			history.push(captureHistory(signature, description));
			if (history.length > 40) disposeHistory(history.shift()!);
			historyIndex = history.length - 1;
			syncHistoryButtons();
		};
		const restoreHistory = (state: HistoryState) => {
			closeCursorHold();
			activePointers.clear();
			touchPositions.clear();
			editTouchIds.clear();
			clearObjects();
			lastMeshTap = null;
			for (const [index, mesh] of state.meshes.entries()) addLiveMesh(copyForFile(mesh, index));
			cursorPosition.copy(state.cursor);
			sceneCamera.position.copy(state.cameraPosition);
			sceneCamera.quaternion.copy(state.cameraRotation);
			sceneCamera.fov = state.cameraFov;
			sceneCamera.updateProjectionMatrix();
			sceneCamera.updateMatrixWorld(true);
			updateCameraHelper();
			if (cameraView) {
				camera.position.copy(sceneCamera.position);
				camera.quaternion.copy(sceneCamera.quaternion);
				camera.fov = sceneCamera.fov;
				camera.updateProjectionMatrix();
			}
			const selected = objects[state.selectedIndex];
			if (selected) {
				if (state.editing) {
					enterEditMode(selected);
					setEditElement?.(state.editElement);
				} else select(selected);
			} else if (state.cameraSelected) select(sceneCamera);
			render();
		};
		jumpToHistory = (index) => {
			if (index < 0 || index >= history.length || index === historyIndex) return;
			historyIndex = index;
			restoreHistory(history[index]);
			syncHistoryButtons();
		};
		undoAction = () => jumpToHistory?.(historyIndex - 1);
		redoAction = () => jumpToHistory?.(historyIndex + 1);
		resetHistory();
		syncModifierUI = () => {
			modifierStack = selection instanceof THREE.Mesh ? readModifiers(selection) : [];
		};
		const changeModifierStack = (mesh: THREE.Mesh, stack: Modifier[], label: string) => {
			try {
				setMeshModifiers(mesh, stack);
				if (selection === mesh) syncModifierUI();
				commitHistory(label);
				render();
			} catch (error) {
				if (selection === mesh) syncModifierUI();
				fileMessage = error instanceof Error ? error.message : 'Modifier update failed';
			}
		};
		addModifier = (type) => {
			if (!(selection instanceof THREE.Mesh) || editMode) return;
			const stack = readModifiers(selection);
			const modifier: Modifier = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				type, axis: 'x', enabled: true, expanded: true, count: 3, spacing: 1.25
			};
			changeModifierStack(selection, [...stack, modifier], `Add ${type} modifier`);
		};
		updateModifier = (id, patch) => {
			if (!(selection instanceof THREE.Mesh) || editMode) return;
			const stack = readModifiers(selection).map((modifier) => modifier.id === id ? {
				...modifier, ...patch,
				count: THREE.MathUtils.clamp(Math.round(Number(patch.count ?? modifier.count) || 2), 2, 20),
				spacing: THREE.MathUtils.clamp(Number(patch.spacing ?? modifier.spacing) || 1.25, 0.1, 10)
			} : modifier);
			changeModifierStack(selection, stack, 'Adjust modifier');
		};
		removeModifier = (id) => {
			if (!(selection instanceof THREE.Mesh) || editMode) return;
			const stack = readModifiers(selection);
			const removed = stack.find((modifier) => modifier.id === id);
			if (removed) changeModifierStack(selection, stack.filter((modifier) => modifier.id !== id),
				`Remove ${removed.type} modifier`);
		};
		toggleModifierExpanded = (id) => {
			if (!(selection instanceof THREE.Mesh)) return;
			const stack = readModifiers(selection).map((modifier) =>
				modifier.id === id ? { ...modifier, expanded: !modifier.expanded } : modifier);
			selection.userData.modifiers = stack;
			modifierStack = stack;
		};
		reorderModifier = (id, targetIndex) => {
			if (!(selection instanceof THREE.Mesh) || editMode) return;
			const stack = readModifiers(selection);
			const currentIndex = stack.findIndex((modifier) => modifier.id === id);
			if (currentIndex < 0) return;
			const [moved] = stack.splice(currentIndex, 1);
			stack.splice(THREE.MathUtils.clamp(targetIndex, 0, stack.length), 0, moved);
			if (stack.every((modifier, index) => modifier.id === modifierStack[index]?.id)) return;
			changeModifierStack(selection, stack, 'Reorder modifiers');
		};
		applyModifierStack = () => {
			if (!(selection instanceof THREE.Mesh) || !readModifiers(selection).length) return;
			delete selection.userData.modifierBase;
			delete selection.userData.modifiers;
			modifierStack = [];
			commitHistory('Apply modifier stack');
			render();
		};
		deleteSelectedObject = () => {
			if (!(selection instanceof THREE.Mesh)) return;
			const mesh = selection;
			if (history[historyIndex]) {
				history[historyIndex].selectedIndex = objects.indexOf(mesh);
				history[historyIndex].editing = editMode;
				history[historyIndex].editElement = editElement;
			}
			closeCursorHold();
			if (editMesh === mesh) leaveEditMode();
			select(null);
			if (pointerStart?.target === mesh) pointerStart = null;
			if (drag?.target === mesh) drag = null;
			if (objectScaleDrag?.mesh === mesh) objectScaleDrag = null;
			if (createDrag?.mesh === mesh) {
				createDrag = null;
				creationGuide.visible = false;
			}
			lastMeshTap = null;
			const index = objects.indexOf(mesh);
			if (index >= 0) objects.splice(index, 1);
			syncSceneItems();
			scene.remove(mesh);
			disposeObject(mesh);
			fileMessage = 'Object deleted';
			commitHistory(`Delete ${mesh.name}`);
			render();
		};
		const onHistoryOrDeleteKey = (event: KeyboardEvent) => {
			if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
			if ((event.ctrlKey || event.metaKey) && !event.altKey) {
				if (event.key.toLowerCase() === 'z') {
					event.preventDefault();
					(event.shiftKey ? redoAction : undoAction)?.();
					return;
				}
				if (event.key.toLowerCase() === 'y') {
					event.preventDefault();
					redoAction?.();
					return;
				}
			}
			if (event.key !== 'Delete' && event.key !== 'Backspace') return;
			if (!(selection instanceof THREE.Mesh)) return;
			event.preventDefault();
			deleteSelectedObject?.();
		};
		window.addEventListener('keydown', onHistoryOrDeleteKey);
		const clearObjects = () => {
			closeCursorHold();
			if (editMesh) leaveEditMode();
			select(null);
			pointerStart = null;
			drag = null;
			objectScaleDrag = null;
			createDrag = null;
			creationGuide.visible = false;
			for (const object of objects.splice(0)) {
				scene.remove(object);
				disposeObject(object);
			}
			syncSceneItems();
		};
		newProject = () => {
			if (objects.length && !window.confirm('Start a new scene? Unsaved changes will be lost.')) return;
			stopFocusAnimation();
			leaveCameraView();
			clearObjects();
			cursorPosition.set(0, 0, 0);
			camera.position.set(15, 15, 13);
			camera.fov = 48;
			camera.updateProjectionMatrix();
			controls.target.set(0, 0, 0);
			controls.update();
			resetSceneCamera();
			resetHistory('New scene');
			fileMenuOpen = false;
			exportOptionsOpen = false;
			fileMessage = 'New scene ready';
			render();
		};
		saveProject = () => {
			const group = fileScene(objects);
			try {
				const data = {
					format: 'blenor-project', version: 1, scene: group.toJSON(),
					cursor: cursorPosition.toArray(),
					camera: (cameraView ? orbitView.position : camera.position).toArray(),
					target: (cameraView ? orbitView.target : controls.target).toArray(),
					viewFov: cameraView ? orbitView.fov : camera.fov,
					sceneCamera: {
						position: sceneCamera.position.toArray(), quaternion: sceneCamera.quaternion.toArray(),
						fov: sceneCamera.fov
					}
				};
				download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${projectName()}.blenor.json`);
				fileMessage = 'Project saved';
				fileMenuOpen = false;
			} catch (error) {
				fileMessage = `Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
			} finally {
				disposeFileScene(group);
			}
		};
		openProject = async (file) => {
			try {
				stopFocusAnimation();
				const data = JSON.parse(await file.text());
				if (data.format !== 'blenor-project' || data.version !== 1 ||
					[data.cursor, data.camera, data.target].some((value) =>
						!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) ||
					(data.viewFov !== undefined && (!Number.isFinite(data.viewFov) || data.viewFov <= 0 || data.viewFov >= 180)) ||
					(data.sceneCamera !== undefined && (
						![data.sceneCamera.position, data.sceneCamera.quaternion].every((value, index) =>
							Array.isArray(value) && value.length === (index === 0 ? 3 : 4) &&
							value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) ||
						!Number.isFinite(data.sceneCamera.fov) || data.sceneCamera.fov <= 0 || data.sceneCamera.fov >= 180))) {
					throw new Error('Unsupported project file');
				}
				const parsed = new THREE.ObjectLoader().parse(data.scene);
				if (!(parsed instanceof THREE.Group) || parsed.children.some((child) =>
					!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshStandardMaterial) ||
					!(child.geometry instanceof THREE.BufferGeometry) || !child.geometry.getAttribute('position'))) {
					throw new Error('Project contains unsupported objects');
				}
				leaveCameraView();
				clearObjects();
				for (const child of [...parsed.children] as THREE.Mesh[]) {
					addLiveMesh(child);
				}
				cursorPosition.fromArray(data.cursor);
				camera.position.fromArray(data.camera);
				camera.fov = data.viewFov ?? 48;
				camera.updateProjectionMatrix();
				controls.target.fromArray(data.target);
				controls.update();
				if (data.sceneCamera) {
					sceneCamera.position.fromArray(data.sceneCamera.position);
					sceneCamera.quaternion.fromArray(data.sceneCamera.quaternion).normalize();
					sceneCamera.fov = data.sceneCamera.fov;
					sceneCamera.updateProjectionMatrix();
					sceneCamera.updateMatrixWorld(true);
					updateCameraHelper();
				} else resetSceneCamera();
				resetHistory('Opened project');
				exportName = file.name.replace(/\.blenor\.json$/i, '') || 'blenor-scene';
				fileMenuOpen = false;
				exportOptionsOpen = false;
				fileMessage = 'Project opened';
				render();
			} catch (error) {
				fileMessage = `Open failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
			}
		};
		exportScene = async () => {
			if (exportBusy) return;
			const source = exportSelectedOnly ? selection instanceof THREE.Mesh ? [selection] : [] : objects;
			if (!source.length && (exportSelectedOnly || !exportIncludeCamera)) {
				fileMessage = exportSelectedOnly ? 'Select an object to export' : 'Add an object to export';
				return;
			}
			const group = fileScene(source);
			for (const child of group.children) if (child instanceof THREE.Mesh) child.userData = {};
			if (!exportSelectedOnly && exportIncludeCamera) group.add(new THREE.PerspectiveCamera().copy(sceneCamera, false));
			if (exportGodotAxes) group.rotation.x = -Math.PI / 2;
			group.updateMatrixWorld(true);
			exportBusy = true;
			fileMessage = 'Exporting…';
			try {
				const result = await new GLTFExporter().parseAsync(group, {
					binary: exportFormat === 'glb', trs: exportTRS, onlyVisible: true
				});
				const blob = result instanceof ArrayBuffer
					? new Blob([result], { type: 'model/gltf-binary' })
					: new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' });
				download(blob, `${projectName()}.${exportFormat}`);
				fileMessage = `${exportFormat.toUpperCase()} exported`;
				exportOptionsOpen = false;
				fileMenuOpen = false;
			} catch (error) {
				fileMessage = `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
			} finally {
				exportBusy = false;
				disposeFileScene(group);
			}
		};

		const resize = () => {
			const { width, height } = viewport.getBoundingClientRect();
			if (!width || !height) return;
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
			sceneCamera.aspect = width / height;
			sceneCamera.updateProjectionMatrix();
			updateCameraHelper();
			renderer.setSize(width, height);
			composer.setSize(width, height);
			render();
		};
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(viewport);
		resize();

		return () => {
			stopFocusAnimation();
			document.removeEventListener('fullscreenchange', syncFullscreen);
			toggleFullscreen = undefined;
			cancelCursorHoldTimer();
			cursorAxesOpen = false;
			deleteSelectedObject = undefined;
			window.removeEventListener('keydown', onHistoryOrDeleteKey);
			for (const state of history) disposeHistory(state);
			undoAction = undefined;
			redoAction = undefined;
			jumpToHistory = undefined;
			addModifier = undefined;
			updateModifier = undefined;
			removeModifier = undefined;
			toggleModifierExpanded = undefined;
			reorderModifier = undefined;
			applyModifierStack = undefined;
			selectFromPane = undefined;
			newProject = undefined;
			saveProject = undefined;
			openProject = undefined;
			exportScene = undefined;
			setSceneCameraFromView = undefined;
			toggleCameraView = undefined;
			addPrimitiveToScene = undefined;
			setTransformTool = undefined;
			setEditElement = undefined;
			exitEditMode = undefined;
			snapCursorToPart = undefined;
			toggleXray = undefined;
			clearEditHighlight();
			if (animationFrame) cancelAnimationFrame(animationFrame);
			resizeObserver.disconnect();
			controls.removeEventListener('change', render);
			controls.removeEventListener('start', stopFocusAnimation);
			controls.dispose();
			transformControls.dispose();
			canvas.removeEventListener('pointerdown', onPointerDown, true);
			canvas.removeEventListener('pointermove', onPointerMove, true);
			canvas.removeEventListener('pointerup', onPointerUp, true);
			canvas.removeEventListener('pointercancel', onPointerCancel, true);
			canvas.removeEventListener('contextmenu', onContextMenu);
			cursor.children.forEach((child) => (child as THREE.Mesh).geometry.dispose());
			cursorRed.dispose();
			cursorWhite.dispose();
			cursorFill.dispose();
			cursorOutline.dispose();
			for (const axis of ['x', 'y', 'z'] as const) {
				handles[axis].line.geometry.dispose();
				(handles[axis].line.material as THREE.Material).dispose();
				handles[axis].knob.geometry.dispose();
				handles[axis].material.dispose();
			}
			guideLine.geometry.dispose();
			guideLineMaterial.dispose();
			guideKnob.geometry.dispose();
			guideKnobMaterial.dispose();
			for (const object of objects) disposeObject(object);
			grid.geometry.dispose();
			(grid.material as THREE.Material).dispose();
			cameraHelper.geometry.dispose();
			if (Array.isArray(cameraHelper.material)) cameraHelper.material.forEach((material) => material.dispose());
			else cameraHelper.material.dispose();
			cameraPivot.geometry.dispose();
			cameraPivotMaterial.dispose();
			fovHandle.geometry.dispose();
			fovHandleMaterial.dispose();
			outlinePass.dispose();
			outputPass.dispose();
			composer.dispose();
			renderer.dispose();
			canvas.remove();
		};
	});
</script>

<svelte:head>
	<title>Blenor — Workspace</title>
	<meta name="description" content="A simple 3D workspace with a perspective grid." />
</svelte:head>

{#snippet auxiliaryPane(side: PaneSide, id: number)}
	<div class="aux-pane">
		<header class="aux-pane-header"><span>{side.toUpperCase()} PANEL {id}</span>
			<button aria-label={`Close ${side} panel`} onclick={() => closePane(side, id)}>×</button></header>
		<div class="aux-pane-tabs" role="group" aria-label="Panel content">
			<button class:active={paneViews[id] !== 'history'} onclick={() => paneViews = { ...paneViews, [id]: 'inspector' }}>Inspector</button>
			<button class:active={paneViews[id] === 'history'} onclick={() => paneViews = { ...paneViews, [id]: 'history' }}>History</button>
		</div>
		<div class="aux-pane-content">
			{#if paneViews[id] === 'history'}
				{#each historyEntries as entry (entry.index)}
					<button class:selected={historyCurrentIndex === entry.index}
						onclick={() => jumpToHistory?.(entry.index)}>{entry.index + 1}. {entry.label}</button>
				{/each}
			{:else}
				<div class="inspector-section-title">SCENE OBJECTS · {sceneItems.length + 1}</div>
				<button class:selected={selectedSceneItem === 'camera'} aria-pressed={selectedSceneItem === 'camera'}
					onclick={() => selectFromPane?.('camera')}>◫ Camera_1</button>
				{#each sceneItems as item (item.index)}
					<button class:selected={selectedSceneItem === item.index} aria-pressed={selectedSceneItem === item.index}
						onclick={() => selectFromPane?.(item.index)}>◇ {item.name}</button>
				{/each}
				{#if !sceneItems.length}<p>No meshes yet. Add a primitive in the viewport.</p>{/if}
				<div class="inspector-details">
					<div class="inspector-section-title">SELECTION</div>
					{#if inspectorDetails}
						<strong>{inspectorDetails.name}</strong>
						<div class="inspector-kind">{inspectorDetails.kind}</div>
						<dl>
							<dt>Position</dt><dd>{inspectorDetails.position.join(', ')}</dd>
							<dt>Rotation °</dt><dd>{inspectorDetails.rotation.join(', ')}</dd>
							{#if inspectorDetails.fov !== undefined}
								<dt>FOV °</dt><dd>{inspectorDetails.fov}</dd>
							{:else}
								<dt>Scale</dt><dd>{inspectorDetails.scale.join(', ')}</dd>
								<dt>Modifiers</dt><dd>{inspectorDetails.modifiers ?? 0}</dd>
							{/if}
						</dl>
					{:else}<p>Select a scene object to inspect it.</p>{/if}
				</div>
			{/if}
		</div>
		<footer>Drag the divider to resize this panel.</footer>
	</div>
{/snippet}

<div class="workspace-root">
	<PaneGroup id="workspace-horizontal" direction="horizontal">
		{#each paneLayout.left as paneId (paneId)}
			<Pane id={`left-${paneId}`} order={paneId} defaultSize={20} minSize={10}>{@render auxiliaryPane('left', paneId)}</Pane>
			<PaneResizer class="pane-resizer horizontal" />
		{/each}
		<Pane id="viewport-column" order={100} defaultSize={Math.max(25, 100 - 20 * (paneLayout.left.length + paneLayout.right.length))} minSize={25}>
			<PaneGroup id="workspace-vertical" direction="vertical">
				{#each paneLayout.top as paneId (paneId)}
					<Pane id={`top-${paneId}`} order={paneId} defaultSize={20} minSize={10}>{@render auxiliaryPane('top', paneId)}</Pane>
					<PaneResizer class="pane-resizer vertical" />
				{/each}
				<Pane id="main-viewport-pane" order={100} defaultSize={Math.max(25, 100 - 20 * (paneLayout.top.length + paneLayout.bottom.length))} minSize={25}>
<main class="viewport" bind:this={viewport} aria-label="3D grid viewport">
	{#if webglUnavailable}
		<p class="fallback">This browser could not start the 3D viewport.</p>
	{/if}
	{#if editGestureZone}
		<div class="edit-gesture-zone" aria-hidden="true" style:left="{editGestureZone.x}px"
			style:top="{editGestureZone.y}px" style:width="{editGestureZone.radius * 2}px"
			style:height="{editGestureZone.radius * 2}px"></div>
	{/if}
	<div class="pane-tab-area">
		<button class="pane-tab" aria-label="Drag to add a panel, or tap for panel options" aria-expanded={paneMenuOpen}
			title="Drag left, right, up, or down to add a panel"
			onpointerdown={onPaneTabDown} onpointermove={onPaneTabMove} onpointerup={onPaneTabUp}
			onpointercancel={onPaneTabCancel}
			onclick={() => { if (performance.now() >= ignorePaneClickUntil) paneMenuOpen = !paneMenuOpen; }}>⋮⋮</button>
		<button class="inspector-launch" class:active={inspectorVisible} aria-pressed={inspectorVisible}
			onclick={toggleInspector}>Inspector</button>
		{#if paneSwipePreview}<div class="pane-swipe-preview" role="status">Add {paneSwipePreview} panel</div>{/if}
		{#if paneMenuOpen}
			<div class="pane-tab-menu" role="group" aria-label="Add panel">
				{#each ['left', 'right', 'top', 'bottom'] as side}
					<button disabled={paneLayout[side as PaneSide].length >= 2} onclick={() => addPane(side as PaneSide)}>Add {side} panel</button>
				{/each}
			</div>
		{/if}
	</div>
	<div class="file-area">
		<input class="file-input" type="file" accept=".json,.blenor.json" bind:this={projectInput}
			onchange={async (event) => {
				const file = event.currentTarget.files?.[0];
				if (file) await openProject?.(file);
				event.currentTarget.value = '';
			}} />
		<button class="file-button" aria-label="File menu" aria-expanded={fileMenuOpen}
			onclick={() => { fileMenuOpen = !fileMenuOpen; exportOptionsOpen = false; }}>File</button>
		{#if fileMenuOpen}
			<div class="file-menu" role="group" aria-label="Project files">
				<button onclick={() => newProject?.()}>New scene</button>
				<button onclick={() => projectInput?.click()}>Open project…</button>
				<button onclick={() => saveProject?.()}>Save project</button>
				<button onclick={() => { fileMenuOpen = false; exportOptionsOpen = true; }}>Export glTF…</button>
			</div>
		{/if}
		{#if exportOptionsOpen}
			<div class="export-panel" role="dialog" aria-label="glTF export options">
				<div class="export-heading">Export for Godot</div>
				<label class="export-field">File name<input bind:value={exportName} aria-label="Export file name" /></label>
				<label class="export-field">Format
					<select bind:value={exportFormat} aria-label="glTF format">
						<option value="glb">Binary .glb</option>
						<option value="gltf">Text .gltf</option>
					</select>
				</label>
				<label class="export-check"><input type="checkbox" bind:checked={exportGodotAxes} /> Convert Z up to Godot Y up</label>
				<label class="export-check"><input type="checkbox" bind:checked={exportSelectedOnly} /> Selected object only</label>
				<label class="export-check"><input type="checkbox" bind:checked={exportIncludeCamera} disabled={exportSelectedOnly} /> Include scene camera</label>
				<label class="export-check"><input type="checkbox" bind:checked={exportTRS} /> Write separate position, rotation, scale</label>
				<div class="export-actions">
					<button onclick={() => exportOptionsOpen = false}>Cancel</button>
					<button class="export-submit" disabled={exportBusy || !exportName.trim()}
						onclick={() => exportScene?.()}>{exportBusy ? 'Exporting…' : 'Export'}</button>
				</div>
			</div>
		{/if}
	</div>
	<div class="camera-area" role="group" aria-label="Camera view controls">
		<button disabled={webglUnavailable || cameraView} onclick={() => setSceneCameraFromView?.()}>Set Camera Here</button>
		<button class:active={cameraView} aria-pressed={cameraView} disabled={webglUnavailable}
			onclick={() => toggleCameraView?.()}>{cameraView ? 'Exit Camera View' : 'Camera View'}</button>
	</div>
	<div class="history-area" role="group" aria-label="Undo, redo, and history">
		<button disabled={!canUndo || webglUnavailable} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" onclick={() => undoAction?.()}>↶ Undo</button>
		<button disabled={!canRedo || webglUnavailable} aria-label="Redo" title="Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)" onclick={() => redoAction?.()}>↷ Redo</button>
		<button class:active={historyListOpen} aria-expanded={historyListOpen} aria-label="History list"
			onclick={() => historyListOpen = !historyListOpen}>History</button>
		<button class:active={isFullscreen} aria-pressed={isFullscreen} disabled={!fullscreenSupported}
			aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
			onclick={() => toggleFullscreen?.()}>{isFullscreen ? 'Exit Fullscreen' : '⛶ Fullscreen'}</button>
		{#if historyListOpen}
			<div class="history-list" role="group" aria-label="Scene history">
				<div class="history-list-title">HISTORY · {historyEntries.length} STATES</div>
				{#each historyEntries as entry (entry.index)}
					<button class:active={historyCurrentIndex === entry.index}
						aria-current={historyCurrentIndex === entry.index ? 'step' : undefined}
						onclick={() => jumpToHistory?.(entry.index)}><span>{entry.index + 1}</span>{entry.label}</button>
				{/each}
			</div>
		{/if}
	</div>
	{#if cameraView}<div class="camera-view-label" aria-hidden="true">CAMERA VIEW</div>{/if}
	{#if fileMessage}<div class="file-message" role="status">{fileMessage}</div>{/if}
	{#if cursorAxesOpen}<div class="cursor-hold-hint" role="status">Drag toward X, Y, or Z to size a box</div>{/if}
	<div class="add-area">
		{#if menuOpen}
			<div class="primitive-menu" role="group" aria-label="Add primitive">
				<div class="menu-title">ADD PRIMITIVE</div>
				{#each primitives as primitive}
					<button onclick={() => addPrimitiveToScene?.(primitive)}>{primitive}</button>
				{/each}
			</div>
		{/if}
		<button class="add-button" aria-label="Add primitive" aria-expanded={menuOpen} disabled={webglUnavailable} onclick={() => menuOpen = !menuOpen}>+</button>
	</div>
	{#if objectSelected && modifiersOpen && !editMode}
		<div class="modifier-panel" role="group" aria-label="Object modifiers">
			<div class="modifier-heading">MODIFIERS · {modifierStack.length}</div>
			<div class="modifier-hint">Drag ⠿ to change the order of operations.</div>
			{#each modifierStack as modifier, index (modifier.id)}
				<div class="modifier-card" class:dragging={draggingModifierId === modifier.id}
					class:drop-target={draggingModifierId !== modifier.id && modifierDropIndex === index}
					data-modifier-id={modifier.id}>
					<div class="modifier-card-header">
						<button class="modifier-drag" aria-label={`Drag to reorder ${modifier.type} modifier`}
							title="Drag to reorder" onpointerdown={(event) => onModifierDragDown(event, modifier.id)}
							onpointermove={onModifierDragMove} onpointerup={onModifierDragUp}
							onpointercancel={onModifierDragCancel}>⠿</button>
						<button class="modifier-collapse" aria-expanded={modifier.expanded}
							onclick={() => toggleModifierExpanded?.(modifier.id)}>{modifier.expanded ? '▾' : '▸'} {modifier.type === 'array' ? 'Array' : 'Mirror'} {index + 1}</button>
						<label class="modifier-enable"><input type="checkbox" checked={modifier.enabled}
							onchange={(event) => updateModifier?.(modifier.id, { enabled: event.currentTarget.checked })} /> On</label>
						<button class="modifier-remove" aria-label={`Delete ${modifier.type} modifier`}
							onclick={() => removeModifier?.(modifier.id)}>×</button>
					</div>
				{#if modifier.expanded}
					<div class="modifier-fields">
						<label>Axis <select value={modifier.axis}
							onchange={(event) => updateModifier?.(modifier.id, { axis: event.currentTarget.value as Modifier['axis'] })}>
							<option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
						</select></label>
						{#if modifier.type === 'array'}
							<label>Count <input type="number" min="2" max="20" step="1" value={modifier.count}
								onchange={(event) => updateModifier?.(modifier.id, { count: Number(event.currentTarget.value) })} /></label>
							<label>Spacing <input type="number" min="0.1" max="10" step="0.1" value={modifier.spacing}
								onchange={(event) => updateModifier?.(modifier.id, { spacing: Number(event.currentTarget.value) })} /></label>
						{:else}<span class="modifier-hint">Mirrors around this object's pivot.</span>{/if}
					</div>
				{/if}
				</div>
			{/each}
			{#if !modifierStack.length}<div class="modifier-hint">Add a modifier to this object.</div>{/if}
			<div class="modifier-actions">
				<button onclick={() => addModifier?.('array')}>+ Array</button>
				<button onclick={() => addModifier?.('mirror')}>+ Mirror</button>
			</div>
			{#if modifierStack.length}<button class="modifier-apply" onclick={() => applyModifierStack?.()}>Apply stack to mesh</button>{/if}
		</div>
	{/if}
	{#if objectSelected || cameraSelected}
		<div class="transform-panel" role="group" aria-label="Object transforms">
			{#if cameraSelected}
				<div class="transform-title">CAMERA</div>
				<button class:active={transformTool === 'move'} aria-pressed={transformTool === 'move'} onclick={() => setTransformTool?.('move')}>Move</button>
				<button class:active={transformTool === 'rotate'} aria-pressed={transformTool === 'rotate'} onclick={() => setTransformTool?.('rotate')}>Rotate</button>
				<span class="gesture-hint">FOV {cameraFov}° · drag amber handle</span>
			{:else if editMode}
				<div class="transform-title">EDIT</div>
				<button class:active={editElement === 'face'} aria-pressed={editElement === 'face'} onclick={() => setEditElement?.('face')}>Face</button>
				<button class:active={editElement === 'edge'} aria-pressed={editElement === 'edge'} onclick={() => setEditElement?.('edge')}>Edge</button>
				<button class:active={editElement === 'vert'} aria-pressed={editElement === 'vert'} onclick={() => setEditElement?.('vert')}>Vert</button>
				{#if editPartSelected}
					<span class="tool-separator" aria-hidden="true"></span>
					<button class:active={transformTool === 'move'} aria-pressed={transformTool === 'move'} onclick={() => setTransformTool?.('move')}>Move</button>
					<button class:active={transformTool === 'rotate'} aria-pressed={transformTool === 'rotate'} disabled={editElement === 'vert'} onclick={() => setTransformTool?.('rotate')}>Rotate</button>
					<button class:active={transformTool === 'scale'} aria-pressed={transformTool === 'scale'} disabled={editElement === 'vert'} onclick={() => setTransformTool?.('scale')}>Scale</button>
					<button onclick={() => snapCursorToPart?.()}>Snap Cursor</button>
					{#if editElement !== 'vert'}
						<button class:active={rotationLocked} aria-pressed={rotationLocked}
							onclick={() => rotationLocked = !rotationLocked}>{rotationLocked ? 'Twist locked' : 'Lock twist'}</button>
					{/if}
					<span class="gesture-hint">Drag to move{editElement === 'vert' ? '' : rotationLocked ? ' · pinch inside ring · ↔ width · ↕ height' : ' · pinch inside ring · ↔ width · ↕ height · twist rotate'}</span>
				{/if}
				<span class="tool-separator" aria-hidden="true"></span>
				<button class:active={xray} aria-pressed={xray} onclick={() => toggleXray?.()}>X ray</button>
				<button aria-label="Exit edit mode" onclick={() => exitEditMode?.()}>Done</button>
			{:else}
				<div class="transform-title">TRANSFORM</div>
				<button class:active={transformTool === 'move'} aria-pressed={transformTool === 'move'} onclick={() => setTransformTool?.('move')}>Move</button>
				<button class:active={transformTool === 'rotate'} aria-pressed={transformTool === 'rotate'} onclick={() => setTransformTool?.('rotate')}>Rotate</button>
				<button class:active={transformTool === 'scale'} aria-pressed={transformTool === 'scale'} onclick={() => setTransformTool?.('scale')}>Scale</button>
				<button class="modifier-toggle" class:active={modifiersOpen} aria-pressed={modifiersOpen}
					onclick={() => modifiersOpen = !modifiersOpen}>Modifiers</button>
				<span class="gesture-hint">Drag object to scale from cursor</span>
			{/if}
			{#if objectSelected}<button class="delete-object" aria-label="Delete selected object" onclick={() => deleteSelectedObject?.()}>Delete</button>{/if}
		</div>
	{/if}
</main>
				</Pane>
				{#each paneLayout.bottom as paneId (paneId)}
					<PaneResizer class="pane-resizer vertical" />
					<Pane id={`bottom-${paneId}`} order={200 + paneId} defaultSize={20} minSize={10}>{@render auxiliaryPane('bottom', paneId)}</Pane>
				{/each}
			</PaneGroup>
		</Pane>
		{#each paneLayout.right as paneId (paneId)}
			<PaneResizer class="pane-resizer horizontal" />
			<Pane id={`right-${paneId}`} order={200 + paneId} defaultSize={20} minSize={10}>{@render auxiliaryPane('right', paneId)}</Pane>
		{/each}
	</PaneGroup>
</div>

<style>
	:global(html), :global(body) { margin: 0; width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; background: #171c24; }
	:global(body) { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #dce3eb; }
	:global(*) { box-sizing: border-box; }
	.workspace-root { width: 100%; height: 100dvh; overflow: hidden; }
	.viewport { position: relative; width: 100%; height: 100%; overflow: hidden; touch-action: none; background: #171c24; }
	:global(.pane-resizer) { position: relative; z-index: 7; flex: none; background: #344457; touch-action: none; }
	:global(.pane-resizer.horizontal) { width: 7px; cursor: col-resize; }
	:global(.pane-resizer.vertical) { height: 7px; cursor: row-resize; }
	:global(.pane-resizer:hover), :global(.pane-resizer[data-active]) { background: #79a8da; }
	.aux-pane { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; background: #202a36; }
	.aux-pane-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 0 10px; border-bottom: 1px solid #3d4c5e; color: #aebed0; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
	.aux-pane-header button { border: 0; background: transparent; color: #c3d3e3; font: inherit; font-size: 20px; cursor: pointer; }
	.aux-pane-tabs { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #3d4c5e; }
	.aux-pane-tabs button { flex: 1; padding: 6px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: #aebed0; font: inherit; font-size: 11px; cursor: pointer; }
	.aux-pane-tabs button:hover, .aux-pane-tabs button.active { border-color: #557ba2; background: #344b65; color: #eff6ff; }
	.aux-pane-content { display: flex; flex: 1; flex-direction: column; gap: 3px; overflow: auto; padding: 10px 8px; }
	.aux-pane-content button { flex: none; overflow: hidden; padding: 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #dce7f3; font: inherit; font-size: 12px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
	.aux-pane-content button:hover { border-color: #557ba2; background: #344b65; }
	.aux-pane-content button.selected { border-color: #ffe28a; background: #474332; box-shadow: inset 3px 0 #ffe28a; color: #fff; }
	.aux-pane-content p, .aux-pane footer { margin: 0; color: #8da0b4; font-size: 11px; line-height: 1.4; }
	.inspector-section-title { padding: 8px 4px 4px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
	.inspector-details { display: grid; gap: 5px; margin-top: 10px; padding: 10px 4px; border-top: 1px solid #3d4c5e; font-size: 12px; }
	.inspector-details strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.inspector-kind { color: #91a5bb; font-size: 11px; }
	.inspector-details dl { display: grid; grid-template-columns: auto 1fr; gap: 7px 8px; margin: 7px 0 0; }
	.inspector-details dt { color: #91a5bb; }
	.inspector-details dd { overflow: hidden; margin: 0; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
	.aux-pane footer { padding: 10px; border-top: 1px solid #3d4c5e; }
	.pane-tab-area { position: absolute; z-index: 8; top: 70px; left: 50%; display: flex; align-items: center; gap: 6px; transform: translateX(-50%); }
	.pane-tab { width: 38px; height: 22px; padding: 0; border: 1px solid #647d9c; border-radius: 8px; background: #26394f; color: #dce7f3; font-size: 17px; line-height: 1; letter-spacing: 2px; cursor: grab; touch-action: none; box-shadow: 0 4px 16px #0007; }
	.pane-tab:active { cursor: grabbing; background: #345b80; }
	.inspector-launch { height: 25px; padding: 0 9px; border: 1px solid #647d9c; border-radius: 7px; background: #26394f; color: #dce7f3; font: inherit; font-size: 11px; cursor: pointer; box-shadow: 0 4px 16px #0007; }
	.inspector-launch:hover, .inspector-launch.active { border-color: #799fc9; background: #34516e; }
	.pane-swipe-preview, .pane-tab-menu { position: absolute; top: 31px; left: 50%; padding: 7px; border: 1px solid #3d4c5e; border-radius: 8px; background: #202a36; box-shadow: 0 8px 28px #0008; font-size: 11px; white-space: nowrap; transform: translateX(-50%); }
	.pane-tab-menu { display: grid; gap: 2px; min-width: 135px; }
	.pane-tab-menu button { padding: 7px; border: 0; border-radius: 5px; background: transparent; color: #dce7f3; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
	.pane-tab-menu button:hover { background: #344b65; }
	.pane-tab-menu button:disabled { opacity: .4; cursor: default; }
	.viewport :global(canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
	.edit-gesture-zone { position: absolute; z-index: 1; border: 1px dashed #ffe28a66; border-radius: 50%; background: radial-gradient(circle, transparent 70%, #ffe28a0a 100%); transform: translate(-50%, -50%); pointer-events: none; }
	.file-area { position: absolute; top: 18px; left: 18px; z-index: 5; }
	.file-input { display: none; }
	.file-button, .file-menu button, .export-actions button { border: 1px solid #49617a; border-radius: 7px; background: #26394f; color: #eff6ff; font: inherit; font-size: 12px; cursor: pointer; }
	.file-button { min-width: 54px; padding: 9px 12px; }
	.file-menu, .export-panel { position: absolute; top: 42px; left: 0; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.file-menu { width: 160px; padding: 6px; }
	.file-menu button { display: block; width: 100%; padding: 9px; border: 0; background: transparent; text-align: left; }
	.file-button:hover, .file-menu button:hover, .export-actions button:hover { background: #34516e; }
	.export-panel { width: min(290px, calc(100vw - 36px)); padding: 14px; color: #dce7f3; font-size: 12px; }
	.export-heading { margin-bottom: 12px; font-size: 13px; font-weight: 700; }
	.export-field { display: grid; gap: 5px; margin-bottom: 11px; color: #aebed0; }
	.export-field input, .export-field select { width: 100%; padding: 8px; border: 1px solid #49617a; border-radius: 6px; background: #172331; color: #eff6ff; font: inherit; }
	.export-check { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; line-height: 1.35; }
	.export-check input { margin: 1px 0 0; accent-color: #78a7d8; }
	.export-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 15px; }
	.export-actions button { padding: 8px 12px; }
	.export-actions button:disabled { opacity: .5; cursor: default; }
	.export-actions .export-submit { background: #345b80; }
	.file-message { position: absolute; top: 20px; left: 84px; max-width: calc(100vw - 110px); padding: 8px 10px; border: 1px solid #3d4c5e; border-radius: 7px; background: #202a36; color: #dce7f3; font-size: 12px; }
	.camera-area { position: absolute; z-index: 4; top: 18px; right: 18px; display: flex; gap: 6px; padding: 5px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.camera-area button { padding: 7px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #dce7f3; font: inherit; font-size: 12px; cursor: pointer; }
	.camera-area button:hover, .camera-area button:focus-visible, .camera-area button.active { border-color: #799fc9; background: #34516e; outline: none; }
	.camera-area button:disabled { opacity: .45; cursor: default; }
	.history-area { position: absolute; z-index: 4; top: 64px; left: 18px; display: flex; gap: 6px; padding: 5px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.history-area button { padding: 7px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #dce7f3; font: inherit; font-size: 12px; cursor: pointer; }
	.history-area button:hover, .history-area button:focus-visible, .history-area button.active { border-color: #799fc9; background: #34516e; outline: none; }
	.history-area button:disabled { opacity: .4; cursor: default; }
	.history-list { position: absolute; z-index: 6; top: 44px; left: 0; width: min(260px, calc(100vw - 36px)); max-height: min(400px, 55dvh); overflow-y: auto; padding: 6px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.history-list-title { padding: 7px 8px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .1em; }
	.history-list button { display: flex; align-items: center; gap: 10px; width: 100%; margin: 1px 0; text-align: left; }
	.history-list button span { min-width: 20px; color: #91a5bb; text-align: right; }
	.camera-view-label { position: absolute; z-index: 2; top: 68px; right: 24px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .12em; pointer-events: none; }
	.cursor-hold-hint { position: absolute; top: 20px; left: 50%; z-index: 2; padding: 8px 11px; border: 1px solid #667b91; border-radius: 7px; background: #202a36e6; color: #eff6ff; font-size: 12px; white-space: nowrap; transform: translateX(-50%); pointer-events: none; }
	.add-area { position: absolute; z-index: 2; left: 24px; bottom: 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
	.add-button { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid #647d9c; border-radius: 10px; background: #26394f; color: #eff6ff; font-family: inherit; font-size: 29px; font-weight: 300; line-height: 1; cursor: pointer; box-shadow: 0 4px 16px #0005; }
	.add-button:hover { background: #34516e; }
	.add-button:disabled { opacity: .5; cursor: default; }
	.primitive-menu { width: 160px; padding: 8px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.menu-title { padding: 7px 9px 9px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
	.primitive-menu button { display: block; width: 100%; padding: 9px; border: 0; border-radius: 6px; background: transparent; color: #dce7f3; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
	.primitive-menu button:hover, .primitive-menu button:focus-visible { background: #344b65; outline: none; }
	.transform-panel { position: absolute; z-index: 2; right: 24px; bottom: 24px; display: flex; align-items: center; gap: 4px; padding: 7px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; }
	.transform-title { padding: 0 10px 0 5px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
	.transform-panel button { padding: 8px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #dce7f3; font: inherit; font-size: 12px; cursor: pointer; }
	.transform-panel button:hover, .transform-panel button:focus-visible { background: #344b65; outline: none; }
	.transform-panel button.active { border-color: #799fc9; background: #34516e; color: #fff; }
	.transform-panel button:disabled { opacity: .4; cursor: default; }
	.transform-panel .delete-object { border-color: #9b5861; color: #ffdce0; }
	.transform-panel .delete-object:hover { background: #713d47; }
	.modifier-panel { position: absolute; z-index: 3; right: 24px; bottom: 82px; width: min(290px, calc(100vw - 34px)); max-height: min(520px, calc(100dvh - 110px)); overflow-y: auto; padding: 12px; border: 1px solid #3d4c5e; border-radius: 10px; background: #202a36; box-shadow: 0 8px 28px #0008; color: #dce7f3; font-size: 12px; }
	.modifier-heading { margin-bottom: 10px; color: #91a5bb; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
	.modifier-card { margin: 7px 0; border: 1px solid #3d4c5e; border-radius: 8px; background: #263443; }
	.modifier-card.dragging { opacity: .5; }
	.modifier-card.drop-target { border-color: #93bde9; box-shadow: 0 0 0 1px #93bde9; }
	.modifier-card-header { display: flex; align-items: center; gap: 3px; min-height: 36px; padding: 3px; }
	.modifier-card-header button { border: 0; border-radius: 5px; background: transparent; color: #dce7f3; font: inherit; cursor: pointer; }
	.modifier-card-header button:hover { background: #40566e; }
	.modifier-drag { width: 29px; height: 29px; font-size: 19px !important; cursor: grab !important; touch-action: none; }
	.modifier-drag:active { cursor: grabbing !important; }
	.modifier-collapse { flex: 1; overflow: hidden; padding: 7px 2px; text-align: left; white-space: nowrap; }
	.modifier-enable { display: flex; align-items: center; gap: 3px; color: #aebed0; font-size: 10px; white-space: nowrap; }
	.modifier-enable input { accent-color: #78a7d8; }
	.modifier-remove { width: 25px; height: 28px; font-size: 17px !important; }
	.modifier-fields { display: grid; gap: 8px; padding: 9px; border-top: 1px solid #3d4c5e; }
	.modifier-fields label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #aebed0; }
	.modifier-fields input, .modifier-fields select { width: 88px; padding: 6px; border: 1px solid #49617a; border-radius: 6px; background: #172331; color: #eff6ff; font: inherit; }
	.modifier-actions { display: flex; gap: 6px; margin-top: 10px; }
	.modifier-actions button, .modifier-apply { flex: 1; padding: 8px; border: 1px solid #49617a; border-radius: 6px; background: #345b80; color: #eff6ff; font: inherit; cursor: pointer; }
	.modifier-apply { width: 100%; margin-top: 8px; background: #26394f; }
	.modifier-actions button:hover, .modifier-apply:hover { background: #456e94; }
	.modifier-hint { color: #91a5bb; font-size: 11px; line-height: 1.35; }
	.gesture-hint { flex: none; padding: 0 8px; color: #91a5bb; font-size: 11px; white-space: nowrap; }
	.tool-separator { width: 1px; height: 22px; margin: 0 3px; background: #3d4c5e; }
	.fallback { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; font-size: 14px; color: #a5b0bd; }
	@media (max-width: 600px) { .pane-tab-area { top: 190px; } .camera-area { top: 64px; right: 17px; } .history-area { top: 114px; left: 17px; max-width: calc(100vw - 34px); } .history-area > button { padding-inline: 6px; font-size: 11px; white-space: nowrap; } .camera-view-label { top: 160px; right: 22px; } .add-area { left: 17px; bottom: 18px; } .transform-panel { right: 17px; bottom: 18px; max-width: calc(100vw - 96px); overflow-x: auto; } .modifier-panel { right: 17px; bottom: 76px; } .transform-panel button { flex: none; } .transform-title { display: none; } }
</style>
