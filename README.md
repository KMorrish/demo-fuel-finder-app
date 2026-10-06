# Fuel finder

A responsive, static Australian fuel-site locator built with native JavaScript modules and the ArcGIS Maps SDK for JavaScript 5.1. It queries the configured fuel-site feature layer only after a search, and does not request location or preselect an address at startup.

## Run locally

1. Copy `config.example.js` to `config.js` and set `ARCGIS_API_KEY` to your ArcGIS Location Platform API key.
2. Serve this directory over HTTP (the ArcGIS SDK modules do not run from a `file://` URL):

   ```powershell
   python -m http.server 8000
   ```

3. Open `http://localhost:8000`.

`config.js` is ignored by Git so your key stays local. Do not put a production key in `config.example.js` or commit `config.js`.

## API key privileges

Create an ArcGIS Location Platform API key with access to the services used by the locator:

- **Basemaps**: access to the ArcGIS streets basemap style and basemap tiles.
- **Geocoding**: access to the ArcGIS World Geocoding service for Australian address suggestions and geocoding. Suggestions and geocoding use `forStorage: false`.
- **Routing**: access to the ArcGIS World Route service for directions and trip planning.
- **Feature service**: access to the `Demo_Fuel_Sites` feature service. The feature layer must allow the browser app to query its features.

Restrict the key to the production site origins where possible, set appropriate usage limits, and rotate it if it is exposed. The key is necessarily available to visitors in a static browser app; origin restrictions and service privileges are the safeguards. There is no sign-in or server-side secret storage.

## Features

- Address search with Australian-only suggestions, an explicit **Use my location** action, and 5, 10, 20, or 50 km search radii.
- Fuel and service filters with independent match-any or match-all behavior.
- Nearest-first results, site details, temporary-closure status, trading hours, fuel types, services, and truck access.
- Simple point-to-point directions and trip planning with sites within 1 km of the route. Stop order is never optimized.
- Browser-generated PDF export of the currently filtered results.

The interface and filters tolerate missing fields in the feature layer: unavailable fields are logged to the browser console and omitted from the UI.
