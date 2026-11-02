# Neuron 3D module

This directory is the frontend integration boundary for the approved React + Three.js renderer.

- `core/`: preserved renderer, atlas, parsing and scientific visualization logic copied from `neuron-3d-visualization/src`.
- `WholeBrainRoot.tsx` and `MPFCNeuronRoot.tsx`: React-facing adapter roots.
- Vue mounts React only through `components/visualization/*Adapter.vue`.
- Data reaches the renderer through `services/api/visualizationApi.ts`; core components do not fetch application data.

The original `neuron-3d-visualization` directory remains an upstream reference and standalone verification fixture. The production website no longer imports across that project boundary.
