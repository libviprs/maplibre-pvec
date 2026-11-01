# Query API

All query methods are on `PVecLayer`. A hit is a `PickResult`: `entityId` (PVec's stable id, never a buffer index), `entityType`, `generation`, `distancePx`, `bounds` and `complete`.

| method | returns |
|---|---|
| `pickPoint(at, { tolerancePx })` | entities under a point, within the stroke half width plus the tolerance |
| `queryRegion(bounds)` | every non-quarantined entity touching the region, once each |
| `nearestEntity(at, radiusPx)` | the closest entity inside a radius, or `undefined` |
| `resolveProvenance(entityId)` | provenance and component data when the file has them and a hook is registered |

Distances are CSS pixels. `complete` is false while part of the searched region is not loaded, so an empty answer is not a proof of absence.

A hit computed against a preview generation is accurate to display fidelity only. `generation` tells you which one you got (0 is a preview). Mathematical tolerances belong to the shared numeric policy ([PVec semantic reuse](pvec-semantic-reuse.md)).

On a real layer the distance is the module's exact one (`entity_distance` and `entity_touches_box`, libviprs/pvec#252), never a distance to the drawn polyline. The index is the Tier 0 draws with each bound widened by the error its preview was declared at, `entityType` is `"entity"` (the packed Tier 0 stream carries no type), a polygon region is not supported (the module tests boxes) and the module keeps a second copy of the file for these calls while the layer is on a map.

Picking targets 5 ms at p95 on 1e6 entities; that was measured with a grid index in Node, not the PVec spatial index (see [deferred work](deferred.md), issue 50). The query tests check ids against a table in the test until the shared index ships.

Signatures: [API reference](api/reference.md).
