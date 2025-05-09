#  GHG Atlas

The **GHG Atlas** is an interactive web application that visualizes global CO₂ emissions using engaging, map-based visualizations. It allows users to explore emission levels by country and year, view emission trends, and compare yearly changes using animated heatmaps. This tool is built using **Flask** for the backend and **D3.js** for the frontend, with data sourced from the EDGAR dataset.

---

##  Features

- Dynamic heatmap showing CO₂ emissions across the globe
- Year-over-year comparison view to track emission changes
- Trend graphs for individual countries on click
- Interactive tooltips showing exact emissions and percentage change
- Smooth UI built with HTML, CSS, and D3.js

---

##  Dependencies

To run this project, you’ll need Python 3.7 or higher and the following Python packages:

```bash
pip install flask pandas numpy
```

Clone the repository:
```bash
git clone https://github.com/chaitanya-0/GHG-Atlas.git
cd GHG-Atlas
```

Start the Flask server:

```bash
python flask_server.py
```