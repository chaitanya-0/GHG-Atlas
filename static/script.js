import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const mapContainer = document.getElementById("mapContainer");
const width = mapContainer.clientWidth;
const height = width * 0.5;
//mapContainer.style.height = height + "px";
const nativeWidth = 3600;
const nativeHeight = 1800;

const canvas = document.getElementById("heatmapCanvas");
canvas.width = nativeWidth;
canvas.height = nativeHeight;
let currentMapType = "flux";

let currentCountryColors = {};

// Set up SVG and the heatmap
const projection = d3
  .geoNaturalEarth1()
  .fitSize([nativeWidth, nativeHeight], { type: "Sphere" });
const path = d3.geoPath().projection(projection);
const svg = d3
  .select("#map")
  .attr("width", nativeWidth)
  .attr("height", nativeHeight);
canvas.style.width = nativeWidth + "px";
canvas.style.height = nativeHeight + "px";

const ctx = canvas.getContext("2d");

async function searchFiles() {
  const query = document.getElementById("searchBox").value;
  const fileList = document.getElementById("fileList");
  fileList.innerHTML = "";

  if (!query) {
    fileList.classList.remove("show");
    return;
  }

  try {
    const response = await fetch(`/search-netcdf?q=${query}`);
    const files = await response.json();

    files.forEach((file) => {
      const item = document.createElement("li");
      item.classList.add("dropdown-item");
      item.style.cursor = "pointer";
      item.textContent = file;
      item.onclick = async () => {
        try {
          const res = await fetch(`/load-netcdf/${encodeURIComponent(file)}`);
          const result = await res.json();
          if (result.status === "ok") {
            drawHeatmap(); //draw the heatmap on successful processing of raw data
            loadMetadata();
            loadContributionPie(null);
          } else {
            alert("Backend failed to process the file.");
          }
        } catch (err) {
          console.error("Error calling backend:", err);
        }
      };

      fileList.appendChild(item);
    });

    if (files.length > 0) {
      fileList.classList.add("show");
    } else {
      fileList.classList.remove("show");
    }
  } catch (error) {
    console.error("Search failed:", error);
    fileList.classList.remove("show");
  }
}

function fetchNetCDF(filename) {
  fetch(`/load-netcdf/${filename}`)
    .then((response) => console.log("Loaded:", response))
    .catch((error) => console.error("Error loading NetCDF file:", error));
}

// Fetch and draw world map
fetch("/world-map")
  .then((response) => response.json())
  .then((geojson) => {
    svg
      .selectAll("path")
      .data(geojson.features)
      .enter()
      .append("path")
      .attr("class", "country")
      .attr("d", path)
      .attr("data-name", (d) => d.properties || "Unknown")
      .style("cursor", "pointer")

      .on("click", function (event, d) {
        if (moved) return; // Don't trigger on drag
        console.log("Clicked country:", d.properties.ADMIN);
        const country = d.properties.ADMIN;
        loadTrendChart(country);
        loadContributionPie(country);
        const tooltip = document.getElementById("countryTooltip");
        const [cx, cy] = path.centroid(d);
        const zoomBox = zoomTarget.getBoundingClientRect();
        const screenX = zoomBox.left + cx * zoom;
        const screenY = zoomBox.top + cy * zoom;

        // Update side card instead of floating tooltip
        const card = document.getElementById("countryCard");
        const cardBody = document.getElementById("countryDetails");
        const introPara = cardBody.querySelector("p.text-muted");
        if (introPara) introPara.remove();
        card.style.display = "block";
      })
      .on("mouseover", function (event, d) {
        d3.select(this)
          .raise()
          .transition()
          .duration(100)
          .style("fill-opacity", 1)
          .style("stroke-width", 1.5);

        const country = d.properties.ADMIN;
        fetch(`/metadata`)
          .then((res) => res.json())
          .then((meta) => {
            const year = meta.year;
            return fetch(
              `/country-year/${encodeURIComponent(country)}/${year}`
            );
          })
          .then((res) => res.json())
          .then((data) => {
            const { emissions, prev_emissions } = data;
            const percentChange =
              prev_emissions && emissions
                ? (
                    ((emissions - prev_emissions) / prev_emissions) *
                    100
                  ).toFixed(2)
                : "N/A";

            const tooltip = document.getElementById("countryTooltip");
            tooltip.innerHTML = `
              <strong>${country}</strong><br>
              Emissions (${data.year}): ${
              emissions ? emissions.toFixed(2) : "N/A"
            } Mt<br>
              Change from ${data.year - 1}: ${percentChange}%`;
            tooltip.style.display = "block";
          });
      })
      .on("mousemove", function (event) {
        const tooltip = document.getElementById("countryTooltip");
        tooltip.style.left = event.pageX + 10 + "px";
        tooltip.style.top = event.pageY + 10 + "px";
      })
      .on("mouseout", function (event, d) {
        const name = d.properties.ADMIN;
    
        const selection = d3.select(this);
        selection.transition().duration(200);
    
        if (currentMapType === "change") {
            selection
              .style("fill", currentCountryColors[name] || "#eee")  // Only in "change" mode
              .style("fill-opacity", 1);
        } else {
            selection
              .style("fill", "transparent")    // In "flux" or "heightmap", keep transparent
              .style("fill-opacity", 1);
        }
    
        selection.style("stroke-width", 0.5);
        document.getElementById("countryTooltip").style.display = "none";
    });
    
  })
  .catch((error) => console.error("Error loading map:", error));

// Fetch and draw heatmap data
// Function to fetch and parse binary data

async function loadBinData(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return new Float32Array(buffer); // Convert binary data to Float32Array
}

async function drawHeightMap() {
  try {
    const [latArray, lonArray, fluxArray] = await Promise.all([
      loadBinData("/heatmap-data/lat.bin"),
      loadBinData("/heatmap-data/lon.bin"),
      loadBinData("/heatmap-data/fluxes.bin"),
    ]);
    const heightmapDiv = document.getElementById("heightmapDiv");
    heightmapDiv.innerHTML = ""; // <--- CLEAR everything previously drawn
    
    const validFluxes = fluxArray.filter(v => v !== -99 && !isNaN(v));

    const fluxMin = d3.min(validFluxes);
    const fluxMax = d3.max(validFluxes);    

    const scene = new THREE.Scene();
    window.heightmapScene = scene;
    const camera = new THREE.PerspectiveCamera(
      45,
      heightmapDiv.clientWidth / heightmapDiv.clientHeight,
      1,
      1000
    );
    camera.position.z = 150;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(heightmapDiv.clientWidth, heightmapDiv.clientHeight);
    heightmapDiv.innerHTML = "";
    heightmapDiv.appendChild(renderer.domElement);

    // SUBSAMPLING: Only every 10th point to avoid overload
    const sampleStep = 2;

    const widthSegments = Math.floor((lonArray.length - 1) / sampleStep);
    const heightSegments = Math.floor((latArray.length - 1) / sampleStep);

    const geometry = new THREE.PlaneGeometry(
      360,
      180,
      widthSegments,
      heightSegments
    );

    const positions = geometry.attributes.position.array;

    const colorScale = d3
      .scaleSequential(d3.interpolateInferno)
      .domain([fluxMin, fluxMax]);
    const colors = [];

    let idx = 0;
    for (let i = 0; i <= heightSegments; i++) {
      for (let j = 0; j <= widthSegments; j++) {
        const latIdx = i * sampleStep;
        const lonIdx = j * sampleStep;
        const index = latIdx * lonArray.length + lonIdx;
        const fluxValue = fluxArray[index] || 0;

        if (fluxValue === 0 || isNaN(fluxValue) || fluxValue === -99) {
          positions[idx * 3 + 2] = 0; // Flat if missing or zero
        } else {
          let normalized = (fluxValue - fluxMin) / (fluxMax - fluxMin);
          normalized = Math.max(0, normalized);
          positions[idx * 3 + 2] = -normalized * 5;
        }        

        const d3Color = d3.color(colorScale(fluxValue));
        colors.push(d3Color.r / 255, d3Color.g / 255, d3Color.b / 255);
        idx++;
      }
    }

    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.4, 
      metalness: 0.6, 
      emissive: new THREE.Color(0x111111), 
      emissiveIntensity: 1.5, 
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI;
    scene.add(mesh);

    // 🚀 Now draw country borders
    try {
      const res = await fetch("/world-map");
      const worldData = await res.json();

      const bordersGroup = new THREE.Group();

      worldData.features.forEach((feature) => {
        const geom = feature.geometry;

        if (geom.type === "Polygon") {
          drawBorder(geom.coordinates, bordersGroup);
        } else if (geom.type === "MultiPolygon") {
          geom.coordinates.forEach((polygon) =>
            drawBorder(polygon, bordersGroup)
          );
        }
      });

      function drawBorder(coordsArray, group) {
        coordsArray.forEach((ring) => {
          const points = ring.map(([lon, lat]) => {
            const x = lon;
            const y = lat; // Flip latitude
            const z = 1.2; // Slightly above the heightmap
            return new THREE.Vector3(x, y, z);
          });

          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const material = new THREE.LineBasicMaterial({
            color: 0x03ff46, // Black border
            linewidth: 1,
          });
          const line = new THREE.Line(geometry, material);
          group.add(line);
        });
      }

      scene.add(bordersGroup);
    } catch (err) {
      console.error("Error drawing borders:", err);
    }

    const ambientLight = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(0, 0, 100);
    scene.add(directionalLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.maxDistance = 500;
    controls.minDistance = 50;

    function animate() {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();
  } catch (error) {
    console.error("Error drawing 3D heightmap:", error);
  }
}

async function drawHeatmap() {
  try {
    document.getElementById("loadingOverlay").style.display = "flex";
    const [latArray, lonArray, fluxArray] = await Promise.all([
      loadBinData("/heatmap-data/lat.bin"),
      loadBinData("/heatmap-data/lon.bin"),
      loadBinData("/heatmap-data/fluxes.bin"),
    ]);

    console.log("Loaded Data.");

    const width = lonArray.length;
    const height = latArray.length;

    const validFluxes = fluxArray.filter(v => v !== -99 && !isNaN(v));

    const vmin = d3.min(validFluxes);
    const vmax = d3.max(validFluxes);
    canvas.dataset.vmin = vmin;
    canvas.dataset.vmax = vmax;

    //const range = vmax - vmin || 1;
    console.log("vmin:", vmin, "vmax:", vmax);
    const colorScale = d3
      .scaleSequential(d3.interpolateInferno)
      .domain([vmin, vmax]);
    drawColorbar(vmin, vmax, colorScale);

    // const projection = d3
    //   .geoMercator()
    //   .fitSize([canvas.width / 2, canvas.height / 1.5], { type: "Sphere" });

    const ctx = document.getElementById("heatmapCanvas").getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // Clear the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let index = 0;
    for (let latIdx = 0; latIdx < height; latIdx++) {
      for (let lonIdx = 0; lonIdx < width; lonIdx++) {
        const value = fluxArray[index];
        index++;

        if (!isNaN(value) && value !== -99) {
          ctx.fillStyle = colorScale(value);
          const [x, y] = projection([lonArray[lonIdx], latArray[latIdx]]);
          ctx.fillRect(x, y, 1, 1);
        }        
      }
    }
    document.getElementById("loadingOverlay").style.display = "none";
  } catch (error) {
    document.getElementById("loadingOverlay").style.display = "none";
    console.error("Error drawing heatmap:", error);
  }
}

// window size = 1000px * 500px. The map should initiate with natural zoomed out view of the earth.
let zoom, offsetX, offsetY;
let isDragging = false;
let startX, startY;

const zoomTarget = document.getElementById("zoomTarget");
const wrapper = document.getElementById("panZoomWrapper");

// 🧠 Compute initial zoom-to-fit and center it
const fitScaleX = wrapper.clientWidth / nativeWidth;
const fitScaleY = wrapper.clientHeight / nativeHeight;
zoom = Math.min(fitScaleX, fitScaleY);

offsetX = (wrapper.clientWidth - nativeWidth * zoom) / 2;
offsetY = (wrapper.clientHeight - nativeHeight * zoom) / 2;

updateTransform(); // Apply initial transform

// Wheel to zoom
wrapper.addEventListener("wheel", (e) => {
  e.preventDefault();

  const rect = wrapper.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const scaleFactor = 1.1;
  const newZoom = zoom * (e.deltaY < 0 ? scaleFactor : 1 / scaleFactor);
  offsetX = mouseX - ((mouseX - offsetX) * newZoom) / zoom;
  offsetY = mouseY - ((mouseY - offsetY) * newZoom) / zoom;

  zoom = newZoom;
  // zoom *= e.deltaY < 0 ? scaleFactor : 1 / scaleFactor;
  updateTransform();
});

// Drag to pan
let moved = false;

wrapper.addEventListener("mousedown", (e) => {
  isDragging = true;
  moved = false;
  startX = e.clientX - offsetX;
  startY = e.clientY - offsetY;
});

wrapper.addEventListener("mousemove", (e) => {
  if (isDragging) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;

    offsetX = e.clientX - startX;
    offsetY = e.clientY - startY;
    updateTransform();
  }
});

wrapper.addEventListener("mouseup", (e) => {
  isDragging = false;

  if (moved) {
    e.stopPropagation();
  }
});

wrapper.addEventListener("mouseup", () => (isDragging = false));
wrapper.addEventListener("mouseleave", () => (isDragging = false));
wrapper.addEventListener("mousemove", (e) => {
  if (isDragging) {
    offsetX = e.clientX - startX;
    offsetY = e.clientY - startY;
    updateTransform();
  }
});

function updateTransform() {
  zoomTarget.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
}
document.addEventListener("click", (e) => {
  const tooltip = document.getElementById("countryTooltip");
  if (!e.target.closest(".country")) {
    tooltip.style.display = "none";
  }
});

async function loadMetadata() {
  try {
    const res = await fetch("/metadata");
    if (!res.ok) throw new Error("Metadata not found");

    const meta = await res.json(); 
    const panel = document.getElementById("metadataPanel");

    const shape =
      Array.isArray(meta.ChunkSizes) && meta.ChunkSizes.length >= 3
        ? `${meta.ChunkSizes[1]} * ${meta.ChunkSizes[2]}`
        : "N/A";

    panel.innerHTML = `
      <div class="table-responsive">
        <table class="table table-bordered table-sm table-striped mb-0 text-center align-middle">
          <thead class="table-light">
            <tr>
              <th scope="col">Substance</th>
              <th scope="col">Year</th>
              <th scope="col">Release</th>
              <th scope="col">Global Total</th>
              <th scope="col">Flux Shape</th>
              <th scope="col">Units</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${meta.substance || "N/A"}</td>
              <td>${meta.year || "N/A"}</td>
              <td>${meta.release || "N/A"}</td>
              <td>${meta.global_total || "N/A"}</td>
              <td>${shape}</td>
              <td>${meta.units || "N/A"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.warn("No metadata found:", err.message);
  }
}
const selectedCountries = [];

function updateSelectedCountriesUI() {
  const panel = document.getElementById("selectedCountriesPanel");
  panel.innerHTML = "";
  selectedCountries.forEach((country) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-outline-secondary btn-sm mx-1";
    btn.textContent = country + " ×";
    btn.onclick = () => {
      selectedCountries.splice(selectedCountries.indexOf(country), 1);
      renderTrendChart();
    };
    panel.appendChild(btn);
  });

  // Add "Clear All" if more than one
  if (selectedCountries.length > 1) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-danger btn-sm";
    clearBtn.textContent = "Clear All";
    clearBtn.onclick = () => {
      selectedCountries.length = 0;
      renderTrendChart();
    };
    panel.appendChild(clearBtn);
  }
}

function loadTrendChart(country) {
  if (!selectedCountries.includes(country)) {
    selectedCountries.push(country);
    renderTrendChart();
  }
}

function drawColorbar(vmin, vmax, colorScale, labelText = "log_10(kg m^-2 s^-1)") {
  const colorbarHeight = 700;
  const colorbarWidth = 20;
  const svg = d3.select("#colorbar");
  svg.selectAll("*").remove();

  const defs = svg.append("defs");
  const gradient = defs
    .append("linearGradient")
    .attr("id", "color-gradient")
    .attr("x1", "0%")
    .attr("y1", "100%")
    .attr("x2", "0%")
    .attr("y2", "0%");

  const n = 50;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const value = vmin + t * (vmax - vmin);
    gradient
      .append("stop")
      .attr("offset", `${t * 100}%`)
      .attr("stop-color", colorScale(value));
  }

  svg
    .append("rect")
    .attr("x", 20)
    .attr("y", 0)
    .attr("width", colorbarWidth)
    .attr("height", colorbarHeight)
    .style("fill", "url(#color-gradient)")
    .style("stroke", "#000")
    .style("stroke-width", 0.5);

  // Units label
  svg
    .append("text")
    .attr("x", 75)
    .attr("y", colorbarHeight + 30)
    .attr("text-anchor", "middle")
    .attr("fill", "#000")
    .style("font-size", "12px")
    .text(labelText);

  const scale = d3
    .scaleLinear()
    .domain([vmin, vmax])
    .range([colorbarHeight, 0]);

  const axis = d3.axisRight(scale).ticks(8).tickFormat(d3.format(".2f"));

  svg
    .append("g")
    .attr("transform", `translate(${colorbarWidth + 30}, 0)`)
    .call(axis);
}

function renderTrendChart() {
  updateSelectedCountriesUI();

  const svg = d3.select("#trendChart");
  const margin = { top: 20, right: 30, bottom: 60, left: 80 };
  const width = +svg.attr("width") - margin.left - margin.right;
  const height = +svg.attr("height") - margin.top - margin.bottom;

  svg.selectAll("*").remove();
  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  if (selectedCountries.length === 0) return;

  const color = d3.scaleOrdinal(d3.schemeTableau10);

  const fetches = selectedCountries.map((c) =>
    fetch(`/country-trend/${encodeURIComponent(c)}`).then((res) => res.json())
  );

  Promise.all(fetches).then((datasets) => {
    const allYears = datasets.flat().map((d) => d.year);
    const allEmissions = datasets.flat().map((d) => d.total_emissions_Mt);

    const x = d3.scaleLinear().domain(d3.extent(allYears)).range([0, width]);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(allEmissions)])
      .range([height, 0]);

    g.append("g")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat(d3.format("d")));

    g.append("g").call(d3.axisLeft(y));

    datasets.forEach((data, i) => {
      const line = d3
        .line()
        .x((d) => x(+d.year))
        .y((d) => y(+d.total_emissions_Mt));

      g.append("path")
        .datum(data)
        .attr("fill", "none")
        .attr("stroke", color(i))
        .attr("stroke-width", 2)
        .attr("d", line);

      g.selectAll(`.circle-${i}`)
        .data(data)
        .enter()
        .append("circle")
        .attr("class", `circle-${i}`)
        .attr("cx", (d) => x(+d.year))
        .attr("cy", (d) => y(+d.total_emissions_Mt))
        .attr("r", 3)
        .attr("fill", color(i));
    });
  });
  const legend = svg
    .append("g")
    .attr("transform", `translate(${margin.left + 10}, ${margin.top})`);

  selectedCountries.forEach((country, i) => {
    const legendRow = legend
      .append("g")
      .attr("transform", `translate(0, ${i * 20})`);

    legendRow
      .append("rect")
      .attr("width", 12)
      .attr("height", 12)
      .attr("fill", color(i));

    legendRow
      .append("text")
      .attr("x", 16)
      .attr("y", 10)
      .attr("fill", "#000")
      .style("font-size", "12px")
      .text(country);
  });
}

async function loadContributionPie(selectedCountry) {
  try {
    const metaRes = await fetch("/metadata");
    const meta = await metaRes.json();
    const year = meta.year || "Unknown";

    const dataRes = await fetch("/global-contributions");
    const data = await dataRes.json();

    // Set chart title with year
    document.querySelector(
      "h5#pieTitle"
    ).textContent = `Global Emissions Distribution (${year})`;

    const svg = d3.select("#pieChart");
    svg.selectAll("*").remove();
    const width = +svg.attr("width");
    const height = +svg.attr("height");
    const radius = Math.min(width, height) / 2 - 30;
    const g = svg
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    const color = d3.scaleOrdinal(d3.schemeTableau10);

    data.sort((a, b) => b.percentage - a.percentage);
    const topCountries = data.slice(0, 9);
    const othersTotal = data.slice(9).reduce((acc, d) => acc + d.percentage, 0);
    topCountries.push({
      country: "Rest of the world",
      percentage: othersTotal,
    });

    const pie = d3.pie().value((d) => d.percentage);
    const arc = d3.arc().innerRadius(0).outerRadius(radius);

    const arcs = g
      .selectAll("g.arc")
      .data(pie(topCountries))
      .enter()
      .append("g")
      .attr("class", "arc");

    arcs
      .append("path")
      .attr("d", arc)
      .attr("fill", (d) =>
        d.data.country === selectedCountry ? "#e63946" : color(d.data.country)
      )
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    const tooltip = d3.select("#pieTooltip");

    arcs
      .on("mouseover", (event, d) => {
        tooltip
          .style("display", "block")
          .html(
            `<strong>${d.data.country}</strong><br>${d.data.percentage.toFixed(
              2
            )}%`
          );
      })
      .on("mousemove", (event) => {
        tooltip
          .style("left", event.pageX + 10 + "px")
          .style("top", event.pageY + 10 + "px");
      })
      .on("mouseout", () => {
        const name = d.properties.ADMIN;
    
        const selection = d3.select(this);
        selection.transition().duration(200);
    
        if (currentMapType === "change") {
            selection
              .style("fill", currentCountryColors[name] || "#eee")  // Only in "change" mode
              .style("fill-opacity", 1);
        } else {
            selection
              .style("fill", "transparent")    // In "flux" or "heightmap", keep transparent
              .style("fill-opacity", 1);
        }
      });

    arcs
      .append("text")
      .attr("transform", (d) => `translate(${arc.centroid(d)})`)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .style("font-size", "11px")
      .style("fill", "#000")
      .text((d) => (d.data.percentage > 3 ? d.data.country : ""));
  } catch (err) {
    console.error("Error loading pie chart or metadata:", err);
  }
}

async function drawChangeMap() {
  const metaRes = await fetch("/metadata");
  const meta = await metaRes.json();
  const year = meta.year;

  const res = await fetch(`/yearly-change/${year}`);
  const changes = await res.json();

  const values = Object.values(changes);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const colorScale = d3
    .scaleDiverging()
    .domain([max, 0, min])
    .interpolator(d3.interpolateRdYlGn);

  drawColorbar(min, max, colorScale, "% change in emissions");

  svg
    .selectAll("path")
    .transition()
    .duration(400)
    .style("fill", (d) => {
      const name = d.properties.ADMIN;
      const fillColor = name in changes ? colorScale(changes[name]) : "#eee";
      currentCountryColors[name] = fillColor;
      return fillColor;
    });
}

document
  .getElementById("mapTypeSelector")
  .addEventListener("change", function () {
    const mapType = this.value;
    currentMapType = mapType;

    const canvas = document.getElementById("heatmapCanvas");
    const heightmapDiv = document.getElementById("heightmapDiv");

    if (mapType === "flux") {
      canvas.style.display = "block";
      heightmapDiv.style.display = "none";

      svg
        .selectAll("path")
        .transition()
        .duration(200)
        .style("fill", "transparent");

      const vmin = canvas.dataset.vmin;
      const vmax = canvas.dataset.vmax;
      if (vmin && vmax) {
        drawColorbar(
          +vmin,
          +vmax,
          d3.scaleSequential(d3.interpolateInferno).domain([+vmin, +vmax])
        );
      }
    } else if (mapType === "change") {
      canvas.style.display = "none";
      heightmapDiv.style.display = "none";
      drawChangeMap();
    } else if (mapType === "heightmap") {
      canvas.style.display = "none";
      heightmapDiv.style.display = "block";
      drawHeightMap();
    }
  });


let currentLat = null;
let currentLon = null;

// Handle "Get Current Location" button
document.getElementById("getLocationBtn").addEventListener("click", () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        currentLat = position.coords.latitude;
        currentLon = position.coords.longitude;
        console.log("Location fetched:", currentLat, currentLon);

        // Only after successful fetch, show the radius input group
        document.getElementById("radiusInputGroup").style.display = "block";
        // 🌟 If heightmap is active and scene is ready, add the marker
        if (currentMapType === "heightmap" && window.heightmapScene) {
          const x = currentLon;
          const y = currentLat;
          const z = 8;

          const geometry = new THREE.ConeGeometry(0.8, 3, 16);
          const material = new THREE.MeshStandardMaterial({
            color: 0xff0000,
            emissive: 0xff0000,
            emissiveIntensity: 1.5,
            metalness: 0.3,
            roughness: 0.4,
          });

          const marker = new THREE.Mesh(geometry, material);
          marker.rotation.x = -Math.PI/2;
          marker.position.set(x, y, z);
          window.heightmapScene.add(marker);
        }
        
      },
      (error) => {
        console.error("Error getting geolocation:", error);
        alert("Failed to get your location.");
      }
    );
  } else {
    alert("Geolocation is not supported by this browser.");
  }
});

// Handle "Calculate Emissions" button
document.getElementById("calculateBtn").addEventListener("click", async () => {
  const radius = document.getElementById("radiusInput").value;

  if (!radius || isNaN(radius) || radius <= 0) {
    alert("Please enter a valid radius in miles.");
    return;
  }
  if (currentLat === null || currentLon === null) {
    alert(
      "Please fetch your location first by clicking 'Get Current Location'."
    );
    return;
  }

  try {
    const res = await fetch(
      `/nearby-emissions?lat=${currentLat}&lon=${currentLon}&radius=${radius}`
    );
    const data = await res.json();

    if (data.error) {
      console.error("Backend Error:", data.error);
      alert("Failed to calculate emissions. See console for details.");
      return;
    }

    console.log("Nearby emissions calculated:", data);

    document.getElementById(
      "totalEmissionSecond"
    ).textContent = `In ${data.year}, every second, ${data.total_emission_second.toFixed(4)} kg of CO2 was emitted within ${radius} miles around you.`;
    document.getElementById(
      "totalEmissionYear"
    ).textContent = `That comes about to be ${data.total_emission_total.toFixed(2)} megatons of CO2 for that year.`;

    document.getElementById("emissionsResult").style.display = "block"; // Ensure results are visible
  } catch (err) {
    console.error("Error fetching nearby emissions:", err);
    alert("Failed to fetch emissions data.");
  }
});

document.getElementById("searchBox").addEventListener("input", searchFiles);


loadMetadata(); // Loads the metadata
drawHeatmap();
loadContributionPie(null);
