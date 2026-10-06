import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type ModifierAxis = 'x' | 'y' | 'z';
export type Modifier = {
	id: string;
	type: 'array' | 'mirror';
	axis: ModifierAxis;
	enabled: boolean;
	expanded: boolean;
	count: number;
	spacing: number;
};

const axisNames: ModifierAxis[] = ['x', 'y', 'z'];
const maxInstances = 128;

export function readModifiers(mesh: THREE.Mesh): Modifier[] {
	const stored = mesh.userData.modifiers;
	if (!Array.isArray(stored)) return [];
	return stored.filter((entry): entry is Partial<Modifier> =>
		entry && typeof entry === 'object' && typeof entry.id === 'string' &&
		(entry.type === 'array' || entry.type === 'mirror'))
		.map((entry) => ({
			id: entry.id!, type: entry.type!,
			axis: axisNames.includes(entry.axis as ModifierAxis) ? entry.axis as ModifierAxis : 'x',
			enabled: entry.enabled !== false, expanded: entry.expanded !== false,
			count: THREE.MathUtils.clamp(Math.round(Number(entry.count) || 3), 2, 20),
			spacing: THREE.MathUtils.clamp(Number(entry.spacing) || 1.25, 0.1, 10)
		}));
}

export function snapshotGeometry(geometry: THREE.BufferGeometry): unknown {
	const plain = new THREE.BufferGeometry().copy(geometry);
	const json = plain.toJSON();
	plain.dispose();
	return json;
}

function flipTriangleWinding(geometry: THREE.BufferGeometry) {
	for (const attribute of Object.values(geometry.attributes) as THREE.BufferAttribute[]) {
		const { array, itemSize, count } = attribute;
		for (let index = 0; index + 2 < count; index += 3) {
			for (let component = 0; component < itemSize; component++) {
				const second = (index + 1) * itemSize + component;
				const third = (index + 2) * itemSize + component;
				const value = array[second];
				array[second] = array[third];
				array[third] = value;
			}
		}
		attribute.needsUpdate = true;
	}
}

export function buildModifierGeometry(baseJson: unknown, stack: Modifier[]): THREE.BufferGeometry {
	const base = new THREE.BufferGeometryLoader().parse(baseJson);
	const template = base.index ? base.toNonIndexed() : base.clone();
	base.dispose();
	template.computeBoundingBox();
	let instances = [new THREE.Matrix4()];
	try {
		for (const modifier of stack) {
			if (!modifier.enabled) continue;
			const copies = modifier.type === 'array' ? modifier.count : 2;
			if (instances.length * copies > maxInstances) {
				throw new Error(`Modifier stack exceeds ${maxInstances} instances`);
			}
			if (modifier.type === 'array') {
				const bounds = new THREE.Box3();
				for (const matrix of instances) bounds.union(template.boundingBox!.clone().applyMatrix4(matrix));
				const step = Math.max(0.1, bounds.getSize(new THREE.Vector3())[modifier.axis]) * modifier.spacing;
				const source = instances;
				instances = [];
				for (let index = 0; index < modifier.count; index++) {
					const offset = new THREE.Vector3();
					offset[modifier.axis] = step * index;
					const translation = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
					for (const matrix of source) instances.push(translation.clone().multiply(matrix));
				}
			} else {
				const mirror = new THREE.Vector3(1, 1, 1);
				mirror[modifier.axis] = -1;
				const reflection = new THREE.Matrix4().makeScale(mirror.x, mirror.y, mirror.z);
				instances = [...instances, ...instances.map((matrix) => reflection.clone().multiply(matrix))];
			}
		}
		const parts = instances.map((matrix) => {
			const geometry = template.clone().applyMatrix4(matrix);
			if (matrix.determinant() < 0) flipTriangleWinding(geometry);
			return geometry;
		});
		try {
			const merged = mergeGeometries(parts, false);
			if (!merged) throw new Error('Could not build modifier geometry');
			merged.computeBoundingBox();
			merged.computeBoundingSphere();
			return merged;
		} finally {
			for (const part of parts) part.dispose();
		}
	} finally {
		template.dispose();
	}
}

export function setMeshModifiers(mesh: THREE.Mesh, stack: Modifier[]): void {
	const baseJson = mesh.userData.modifierBase ?? snapshotGeometry(mesh.geometry);
	const nextGeometry = stack.length
		? buildModifierGeometry(baseJson, stack)
		: new THREE.BufferGeometryLoader().parse(baseJson);
	const oldGeometry = mesh.geometry;
	mesh.geometry = nextGeometry;
	mesh.userData.modifiers = stack.map((modifier) => ({ ...modifier }));
	if (stack.length) mesh.userData.modifierBase = baseJson;
	else delete mesh.userData.modifierBase;
	oldGeometry.dispose();
}

export function shiftModifierBase(mesh: THREE.Mesh, offset: THREE.Vector3): void {
	if (!mesh.userData.modifierBase) return;
	const base = new THREE.BufferGeometryLoader().parse(mesh.userData.modifierBase);
	base.translate(offset.x, offset.y, offset.z);
	mesh.userData.modifierBase = snapshotGeometry(base);
	base.dispose();
}
