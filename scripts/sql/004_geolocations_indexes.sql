-- Spatial indexes for Haryana geolocation tables (lat/lon points)

CREATE INDEX IF NOT EXISTS idx_haryana_ambulance_coords
    ON public.haryana_ambulance (latitude, longitude);

CREATE INDEX IF NOT EXISTS idx_haryana_bloodbanks_coords
    ON public.haryana_bloodbanks (latitude, longitude);

CREATE INDEX IF NOT EXISTS idx_haryana_hosp_coords
    ON public.haryana_hosp (latitude, longitude);
