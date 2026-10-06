# Fuel locator

A standalone browser app built with the ArcGIS Maps SDK for JavaScript. It opens web map `cee7757ff62743b2b26013e560914faa` and uses the ArcGIS World Geocoding service for address searches.

## Run locally

Serve this directory over HTTP (the ArcGIS SDK cannot be loaded reliably from a `file://` URL):

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`.

The browser needs network access to ArcGIS Online, the ArcGIS JavaScript SDK, and jsDelivr for PDF export. The web map and its feature layers must be shared with the signed-in user or publicly accessible. Product, service, and amenity filters are built from the loaded layer's field names and aliases.
