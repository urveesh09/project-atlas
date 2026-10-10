import { z } from 'zod';
import { LIMITS } from './limits.js';
import { DistrictIdSchema, LayoutIdSchema, LineageIdSchema, NodeIdSchema, PackagePathSchema, SnapshotIdSchema } from './primitives.js';

/** Layout contract (plan §11.2). All geometry is integer; one cell = 100 units. */
export const UNITS_PER_CELL = 100;
export const MAX_COORDINATE = 2 ** 31 - 1;

const Coordinate = z.number().int().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const Extent = z.number().int().positive().max(MAX_COORDINATE);

export const RectSchema = z.strictObject({ x: Coordinate, z: Coordinate, width: Extent, depth: Extent });

/** Heights are quantized to thousandths and clamped to the documented encoding range. */
export const HeightSchema = z
  .number()
  .min(0)
  .max(14)
  .refine((h) => Math.abs(h * 1000 - Math.round(h * 1000)) < 1e-6, 'Height must be quantized to 0.001');

export const LayoutArtifactSchema = z.strictObject({
  layoutVersion: z.literal('atlas.layout/1.0.0'),
  layoutId: LayoutIdSchema,
  unitsPerCell: z.literal(UNITS_PER_CELL),
  root: RectSchema,
  districts: z
    .array(
      z.strictObject({
        id: DistrictIdSchema,
        parentId: DistrictIdSchema.nullable(),
        rect: RectSchema,
        anchorPath: PackagePathSchema,
      }),
    )
    .max(LIMITS.historicalUnionLineages * 2),
  plots: z
    .array(
      z.strictObject({
        lineageId: LineageIdSchema,
        districtId: DistrictIdSchema,
        rect: RectSchema,
        seed: z.number().int().min(1).max(0xffffffff),
      }),
    )
    .max(LIMITS.historicalUnionLineages),
  externalAnchors: z
    .array(z.strictObject({ canonicalName: z.string().min(1).max(256), x: Coordinate, z: Coordinate }))
    .max(10_000),
  frameState: z
    .array(
      z.strictObject({
        snapshotId: SnapshotIdSchema,
        containers: z.array(z.strictObject({ graphNodeId: NodeIdSchema, layoutDistrictId: DistrictIdSchema.nullable() })),
        files: z.array(
          z.strictObject({
            nodeId: NodeIdSchema,
            lineageId: LineageIdSchema,
            currentParentId: NodeIdSchema,
            height: HeightSchema,
            present: z.literal(true),
          }),
        ),
      }),
    )
    .max(LIMITS.analyzedFrames),
});

export type Rect = z.infer<typeof RectSchema>;
export type LayoutArtifact = z.infer<typeof LayoutArtifactSchema>;
export type LayoutDistrict = LayoutArtifact['districts'][number];
export type LayoutPlot = LayoutArtifact['plots'][number];
