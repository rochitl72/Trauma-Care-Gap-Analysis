CREATE TABLE IF NOT EXISTS india_admin_boundary.grid_cell (
    id BIGSERIAL PRIMARY KEY,
    district TEXT NOT NULL,
    state_ut TEXT NOT NULL,
    grid_type TEXT NOT NULL CHECK (grid_type IN ('hex', 'circle', 'road')),
    cell_radius_m DOUBLE PRECISION NOT NULL DEFAULT 5000,
    geometry geometry(Geometry, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grid_cell_geometry
    ON india_admin_boundary.grid_cell USING gist (geometry);

CREATE INDEX IF NOT EXISTS idx_grid_cell_lookup
    ON india_admin_boundary.grid_cell (grid_type, state_ut, district);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grid_cell_dedup
    ON india_admin_boundary.grid_cell (grid_type, district, state_ut, (md5(ST_AsBinary(geometry))));
