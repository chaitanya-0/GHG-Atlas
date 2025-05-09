import geopandas as gpd
import pandas as pd
import numpy as np
from shapely.geometry import Point
from netCDF4 import Dataset
from time import time
from pyproj import Geod
import os
from datetime import datetime

geod = Geod(ellps="WGS84")

def compute_cell_area(lat, lon, dlat=0.1, dlon=0.1):
    lat1 = lat - dlat / 2
    lat2 = lat + dlat / 2
    lon1 = lon - dlon / 2
    lon2 = lon + dlon / 2
    lons = [lon1, lon1, lon2, lon2]
    lats = [lat1, lat2, lat2, lat1]
    area, _ = geod.polygon_area_perimeter(lons=lons, lats=lats)
    return abs(area)  # area in square meters

t_orig = time()
world = gpd.read_file("geojson/ne_110m_admin_0_countries.json")

DATA_DIR = "E:\\Rutgers\\Spring25\\CS526 - Data Int and Vis Analytics\\Project\\EDGAR\\data\\"
FILE_NAMES = [f for f in os.listdir(DATA_DIR) if f.endswith(".nc")]

for file in FILE_NAMES:
    dataset = Dataset(os.path.join(DATA_DIR, file), "r")
    lats = dataset.variables["lat"][:]
    lons = dataset.variables["lon"][:]
    values = dataset.variables["fluxes"][:] #units are kg/m^2/s

    lon_grid, lat_grid = np.meshgrid(lons, lats)

    lat_flat = lat_grid.ravel()
    lon_flat = lon_grid.ravel()
    val_flat = values.ravel()

    df = pd.DataFrame({
        "lat": lat_flat,
        "lon": lon_flat,
        "value": val_flat
    })

    meta = str(dataset.variables['fluxes'])
    year = int(meta[meta.find('year') + 6:meta.find('year') + 6 + 4])
    st = datetime(year, 1, 1)
    en = datetime(year+1, 1, 1)
    df['value'] *= (en - st).total_seconds() # multiply by the number of seconds in that year.

    df["cell_area_m2"] = df.apply(lambda row: compute_cell_area(row["lat"], row["lon"]), axis=1)

    df["emission_kg"] = df["value"] * df["cell_area_m2"]

    df["geometry"] = [Point(xy) for xy in zip(df["lon"], df["lat"])]
    gdf_points = gpd.GeoDataFrame(df, geometry="geometry", crs="EPSG:4326")

    joined = gpd.sjoin(gdf_points, world, how="left", predicate="within")

    country_emissions = (
        joined.groupby("ADMIN")["emission_kg"]
        .sum()
        .reset_index()
        .rename(columns={"emission_kg": "total_emissions_kg"})
    )
    country_emissions["total_emissions_Mt"] = country_emissions["total_emissions_kg"] / 1e9

    output_name = os.path.splitext(file)[0] + "_processed_aggregates.csv"
    country_emissions.to_csv(os.path.join(DATA_DIR, "data_pr", output_name), index=False)

    print(f"{file} processed in {(time() - t_orig) / 60} minutes.")

print("===============\n", f"The program took overall {(time() - t_orig) / 60} minutes.")
