from flask import Flask, jsonify, render_template, send_file, request
from pyproj import Geod
from netCDF4 import Dataset
import numpy as np
import json
import os
import math
import geopandas as gpd
import pandas as pd
from datetime import datetime
import time

app = Flask(__name__)

# Load world map GeoJSON
with open(r"geojson\ne_110m_admin_0_countries.json", "r") as f:
    world_map = json.load(f)

world = gpd.read_file(r"geojson\ne_110m_admin_0_countries.json")

# NetCDF file path
NC_FILE_PATH = "EDGAR_2024_GHG_CO2_2023_TOTALS_flx.nc"
DATA_DIR = r"EDGAR/data/"

dataset, lats, lons, values = None, None, None, None


def extract_nc_data():
    """Read NetCDF file and return a JSON of lat/lon/values for heatmap"""
    try:
        dataset = Dataset(NC_FILE_PATH, "r")

        # Assume variable of interest is named 'co2' (change as needed)
        var_name = "fluxes"
        if var_name not in dataset.variables:
            return {"error": f"Variable '{var_name}' not found in NetCDF file"}

        # Extract latitude, longitude, and data
        lats = dataset.variables["lat"][:]
        lons = dataset.variables["lon"][:]
        values = dataset.variables[var_name][:]
        values_masked = np.ma.masked_where(values <= 0, values)
        values_log = np.ma.masked_where(
            values_masked <= 0, np.log10(np.clip(values_masked, 1e-10, None))
        )
        dataset.close()
        values_log = values_log.filled(np.nan)
        values_log = np.nan_to_num(values_log, nan=0)
        values_log = np.asarray(values_log)
        np.save("lat.npy", lats)  # Store actual latitude values
        np.save("lon.npy", lons)  # Store actual longitude values
        np.save("fluxes.npy", values_log)
        test = values_log <= 0
        print(
            "==============================\n",
            np.any(test),
            np.max(values_log),
            np.min(values_log),
            "\n==============================",
        )
        # Create list of {lat, lon, value} objects
        data = [
            {"lat": float(lat), "lon": float(lon), "value": float(val)}
            for lat, row in zip(lats, values_log)
            for lon, val in zip(lons, row)
        ]
        # print("==============================\n",data,"\n==============================")
        return data

    except Exception as e:
        return {"error": str(e)}


@app.route("/country-trend/<country_name>")
def country_trend(country_name):
    year_range = range(1970, 2023)
    trend = []

    for year in year_range:
        file_path = DATA_DIR + "data_pr/"
        file = next(
            (f for f in os.listdir(file_path) if f.endswith(".csv") and str(year) in f),
            None,
        )
        if file:
            df = pd.read_csv(os.path.join(file_path, file))
            match = df[df["ADMIN"] == country_name]
            if not match.empty:
                emission = float(match["total_emissions_Mt"].values[0])
                trend.append({"year": year, "total_emissions_Mt": emission})
    return jsonify(trend)


@app.route("/")
def index():
    print("serving the home page...")
    return render_template("index.html")


@app.route("/world-map")
def get_world_map():
    """Serve world map GeoJSON"""
    print("Making the world map over SVG...")
    return jsonify(world_map)


@app.route("/search-netcdf")
def search_netcdf():
    """Search for .nc files matching the query"""
    query = request.args.get("q", "").lower()

    # Get all .nc files in the directory
    all_files = [f for f in os.listdir(DATA_DIR) if f.endswith(".nc")]
    # Filter based on user input
    matching_files = [f for f in all_files if query in f.lower()]

    return jsonify(matching_files)  # Return the filtered list


@app.route("/load-netcdf/<filename>")
def make_bin(filename):
    try:
        dataset = Dataset(DATA_DIR + filename, "r")
        var_name = "fluxes"

        if var_name not in dataset.variables:
            print(f"Variable '{var_name}' not found in NetCDF file")
            return {"error": f"Variable '{var_name}' not found in NetCDF file"}

        lats = dataset.variables["lat"][:]
        lons = dataset.variables["lon"][:]
        values = dataset.variables[var_name][:]

        # 1️⃣ Clip extremely small values but preserve zeros separately
        values_safe = np.clip(values, 1e-10, None)

        # 2️⃣ Take log10 everywhere
        values_log = np.log10(values_safe)

        # 3️⃣ Where original was missing/zero, set log to -99
        mask_missing = ~np.isfinite(values) | (values <= 0)
        values_log[mask_missing] = -99

        # Save
        lats = np.asarray(lats)
        lons = np.asarray(lons)
        values_log = np.asarray(values_log)

        lats.astype(np.float32).tofile("temp/lat.bin")
        lons.astype(np.float32).tofile("temp/lon.bin")
        values_log.astype(np.float32).tofile("temp/fluxes.bin")

        # Metadata saving (same as yours)
        metadata = {}
        for attr in dataset["fluxes"].ncattrs():
            val = dataset["fluxes"].getncattr(attr)
            if isinstance(val, np.ndarray):
                metadata[attr] = val.tolist()
            elif isinstance(val, (np.float32, np.float64)):
                metadata[attr] = "NaN" if math.isnan(val) else float(val)
            elif isinstance(val, np.int64):
                metadata[attr] = float(val)
            else:
                metadata[attr] = val

        with open("temp/metadata.json", "w") as file:
            json.dump(metadata, file, indent=4)

        dataset.close()
        print("\n\n Everything went OK. Loaded files.\n\n")
        return jsonify({"status": "ok", "metadata": metadata})

    except Exception as e:
        print("ERROR:", str(e))
        return {"error": str(e)}

@app.route("/metadata")
def serve_metadata():
    try:
        print("SENDING METADATA")
        return send_file("temp/metadata.json", mimetype="application/json")
    except Exception as e:
        print("ERROR IN METADATA:", str(e))
        return jsonify({"error": str(e)}), 404


@app.route("/heatmap-data/<filename>")
def get_heatmap_data(filename):
    try:
        valid_files = ["lat.bin", "lon.bin", "fluxes.bin", "metadata.json"]
        if filename in valid_files:
            print("\n sending file... ", filename, "\n")
            return send_file("temp/" + filename)
        return "Invalid file request", 400

    except Exception as e:
        return {"error": str(e)}


@app.route("/global-contributions")
def global_contri():
    try:
        file_path = DATA_DIR + "data_pr/"

        with open("temp/metadata.json", "r") as f:
            meta = json.load(f)

        curr_yr = meta["year"]
        file = next(
            (
                f
                for f in os.listdir(file_path)
                if f.endswith(".csv") and str(curr_yr) in f
            ),
            None,
        )
        dfc = pd.read_csv(os.path.join(file_path, file))
        df2 = dfc[["ADMIN", "total_emissions_Mt"]]
        df2["total_emissions_Mt"] /= df2["total_emissions_Mt"].sum()
        df2["total_emissions_Mt"] *= 100
        df2 = df2.rename(columns={"total_emissions_Mt": "percentage"})
        df2 = df2.rename(columns={"ADMIN": "country"})
        df2_dict = df2.to_dict(orient="records")
        # print("\n\n\n HERE BE THE HOLY DICT: \n\n", df2_dict)
        return jsonify(df2_dict)

    except Exception as e:
        print(e)


@app.route("/country-year/<country_name>/<int:year>")
def country_year(country_name, year):
    try:
        file_path = DATA_DIR + "data_pr/"
        curr_file = next(
            (f for f in os.listdir(file_path) if f.endswith(".csv") and str(year) in f),
            None,
        )
        prev_file = next(
            (
                f
                for f in os.listdir(file_path)
                if f.endswith(".csv") and str(year - 1) in f
            ),
            None,
        )
        curr_em, prev_em = None, None

        if curr_file:
            df = pd.read_csv(os.path.join(file_path, curr_file))
            match = df[df["ADMIN"] == country_name]
            if not match.empty:
                curr_em = float(match["total_emissions_Mt"].values[0])

        if prev_file:
            df = pd.read_csv(os.path.join(file_path, prev_file))
            match = df[df["ADMIN"] == country_name]
            if not match.empty:
                prev_em = float(match["total_emissions_Mt"].values[0])

        return jsonify(
            {
                "country": country_name,
                "year": year,
                "emissions": curr_em,
                "prev_emissions": prev_em,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/yearly-change/<int:year>")
def yearly_change(year):
    try:
        file_path = DATA_DIR + "data_pr/"
        file_this = next(
            (f for f in os.listdir(file_path) if f.endswith(".csv") and str(year) in f),
            None,
        )
        file_prev = next(
            (
                f
                for f in os.listdir(file_path)
                if f.endswith(".csv") and str(year - 1) in f
            ),
            None,
        )

        if not file_this or not file_prev:
            return jsonify({})

        df_curr = pd.read_csv(os.path.join(file_path, file_this))
        df_prev = pd.read_csv(os.path.join(file_path, file_prev))

        merged = pd.merge(df_curr, df_prev, on="ADMIN", suffixes=("_curr", "_prev"))
        merged["pct_change"] = (
            100
            * (merged["total_emissions_Mt_curr"] - merged["total_emissions_Mt_prev"])
            / merged["total_emissions_Mt_prev"]
        )

        result = dict(zip(merged["ADMIN"], merged["pct_change"]))
        return jsonify(result)
    except Exception as e:
        print("Error computing yearly change:", str(e))
        return jsonify({})


@app.route("/nearby-emissions")
def nearby_emissions():
    try:
        lat0 = float(request.args.get("lat"))
        lon0 = float(request.args.get("lon"))
        Rmi = float(request.args.get("radius", 10))
        Rm = Rmi * 1609.34 

        lats = np.fromfile("temp/lat.bin", np.float32)
        lons = np.fromfile("temp/lon.bin", np.float32)
        f_log = np.fromfile("temp/fluxes.bin", np.float32)
        f_log = f_log.reshape(lats.size, lons.size)

        mask_valid = ~(np.isnan(f_log) & (f_log <= 0))
        flux = np.zeros_like(f_log, dtype=np.float32)
        flux[mask_valid] = np.power(10.0, f_log[mask_valid])
        
        deg_lat = Rm / 111320  
        deg_lon = Rm / (111320 * np.cos(np.radians(lat0)))  

        lat_mask = (lats >= lat0 - deg_lat) & (lats <= lat0 + deg_lat)
        lon_mask = (lons >= lon0 - deg_lon) & (lons <= lon0 + deg_lon)

        if not lat_mask.any() or not lon_mask.any():
            return jsonify(
                {"total_emission_second": 0, "total_emission_total": 0, "year": None}
            )

        sub_flux = flux[np.ix_(lat_mask, lon_mask)]
        sub_lats = lats[lat_mask]
        sub_lons = lons[lon_mask]

        lon_grid, lat_grid = np.meshgrid(sub_lons, sub_lats)
        geod = Geod(ellps="WGS84")
        _, _, dist_m = geod.inv(
            np.full(lon_grid.shape, lon0),
            np.full(lat_grid.shape, lat0),
            lon_grid,
            lat_grid,
        )

        inside = dist_m <= Rm
        if not inside.any():
            return jsonify(
                {"total_emission_second": 0, "total_emission_total": 0, "year": None}
            )
        lon_size = sub_lons.size
        lat_rad  = np.radians(sub_lats)
        dlat = np.abs(lats[1] - lats[0]) * np.pi / 180 
        dlon = np.abs(lons[1] - lons[0]) * np.pi / 180 
        R = 6371000  
        phi1 = np.radians(sub_lats) - dlat / 2
        phi2 = np.radians(sub_lats) + dlat / 2
        strip_area = R**2 * dlon * (np.sin(lat_rad + dlat/2) - np.sin(lat_rad - dlat/2))
        cell_area  = np.repeat(strip_area[:,None], lon_size, axis=1)  
        total_kg_s = np.nansum( sub_flux[inside] * cell_area[inside] )

        with open("temp/metadata.json") as fh:
            yr = int(json.load(fh)["year"])
        seconds_year = (datetime(yr + 1, 1, 1) - datetime(yr, 1, 1)).total_seconds()
        total_Mt = (total_kg_s * seconds_year) / 1e9  

        return jsonify(
            {
                "total_emission_second": float(total_kg_s),
                "total_emission_total": float(total_Mt),
                "year": yr,
            }
        )

    except Exception as e:
        print("nearby_emissions error:", e)
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
