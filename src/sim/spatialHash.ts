/**
 * 3D Spatial Hash Grid for O(N) range-limited gravity and collision queries.
 * Reuses internal arrays across frames to minimize garbage collection.
 */
export class SpatialHashGrid {
  private cellSize: number;
  private invCellSize: number;
  private buckets: Map<number, number[]>;
  private pool: number[][];

  constructor(cellSize = 10.0) {
    this.cellSize = cellSize;
    this.invCellSize = 1.0 / cellSize;
    this.buckets = new Map();
    this.pool = [];
  }

  public clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
      this.pool.push(bucket);
    }
    this.buckets.clear();
  }

  private hashCoords(cx: number, cy: number, cz: number): number {
    // Large primes for 3D integer spatial hashing
    const h =
      Math.imul(cx, 73856093) ^
      Math.imul(cy, 19349663) ^
      Math.imul(cz, 83492791);
    return h;
  }

  public insert(index: number, x: number, y: number, z: number): void {
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const key = this.hashCoords(cx, cy, cz);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = this.pool.pop() || [];
      this.buckets.set(key, bucket);
    }
    bucket.push(index);
  }

  /**
   * Visits all item indices in cells overlapping the AABB [x ± radius, y ± radius, z ± radius]
   */
  public queryRadius(
    x: number,
    y: number,
    z: number,
    radius: number,
    outIndices: number[]
  ): void {
    outIndices.length = 0;
    const minX = Math.floor((x - radius) * this.invCellSize);
    const maxX = Math.floor((x + radius) * this.invCellSize);
    const minY = Math.floor((y - radius) * this.invCellSize);
    const maxY = Math.floor((y + radius) * this.invCellSize);
    const minZ = Math.floor((z - radius) * this.invCellSize);
    const maxZ = Math.floor((z + radius) * this.invCellSize);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const bucket = this.buckets.get(this.hashCoords(cx, cy, cz));
          if (bucket) {
            for (let i = 0; i < bucket.length; i++) {
              outIndices.push(bucket[i]);
            }
          }
        }
      }
    }
  }
}
