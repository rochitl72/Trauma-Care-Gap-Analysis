ALTER TABLE india_admin_boundary.grid_cell
    DROP CONSTRAINT IF EXISTS grid_cell_grid_type_check;

ALTER TABLE india_admin_boundary.grid_cell
    ADD CONSTRAINT grid_cell_grid_type_check
    CHECK (grid_type IN ('hex', 'circle', 'road'));
