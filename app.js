import esriConfig from "https://js.arcgis.com/5.1/@arcgis/core/config.js";
import ArcGISMap from "https://js.arcgis.com/5.1/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/5.1/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/5.1/@arcgis/core/layers/FeatureLayer.js";
import Graphic from "https://js.arcgis.com/5.1/@arcgis/core/Graphic.js";
import Point from "https://js.arcgis.com/5.1/@arcgis/core/geometry/Point.js";
import * as geometryEngine from "https://js.arcgis.com/5.1/@arcgis/core/geometry/geometryEngine.js";
import { suggestLocations, addressToLocations } from "https://js.arcgis.com/5.1/@arcgis/core/rest/locator.js";
import { solve } from "https://js.arcgis.com/5.1/@arcgis/core/rest/route.js";
import RouteParameters from "https://js.arcgis.com/5.1/@arcgis/core/rest/support/RouteParameters.js";
import FeatureSet from "https://js.arcgis.com/5.1/@arcgis/core/rest/support/FeatureSet.js";

const FEATURE_LAYER_URL = "https://services8.arcgis.com/1yh1pVPFxM2Ak2IX/arcgis/rest/services/Demo_Fuel_Sites/FeatureServer/0";
const GEOCODER_URL = "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";
const ROUTE_URL = "https://route-api.arcgis.com/arcgis/rest/services/World/RouteServer";
const FIELD_GROUPS = {
  fuels: [
    ["unleaded_91", "Unleaded 91"], ["unleaded_e10", "Unleaded E10"], ["unleaded_95", "Unleaded 95"],
    ["premium_98", "Premium 98"], ["diesel", "Diesel"], ["premium_diesel", "Premium Diesel"],
    ["high_flow_diesel", "High Flow Diesel"], ["autogas", "Autogas"], ["adblue_at_pump", "AdBlue at pump"],
    ["adblue_by_pack", "AdBlue by pack"]
  ],
  services: [
    ["atm", "ATM"], ["toilets", "Toilets"], ["showers", "Showers"], ["carwash", "Car wash"],
    ["retail_shop", "Shop"], ["takeaway_food", "Takeaway food"], ["restaurant", "Restaurant"],
    ["weighbridge", "Weighbridge"], ["truck_parking", "Truck parking"]
  ],
  truck: [
    ["semi_trailer_accessible", "Semi-trailer"], ["b_double_accessible", "B-double"],
    ["road_train_accessible", "Road train"]
  ]
};
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOUR_FIELDS = DAY_NAMES.flatMap((day) => {
  const key = day.slice(0, 3).toLowerCase();
  return [[`${key}_opening`, `${day} opening`], [`${key}_closing`, `${day} closing`]];
});
const DETAIL_FIELDS = [
  ["displayname", "Site name"], ["street", "Street"], ["suburb", "Suburb"], ["state", "State"],
  ["postcode", "Postcode"], ["phone", "Phone"], ["status", "Status"],
  ["temp_closed_from", "Temporary closure start"], ["temp_closed_to", "Temporary closure end"],
  ["open_24_hours", "Open 24 hours"], ...HOUR_FIELDS,
  ...FIELD_GROUPS.fuels, ...FIELD_GROUPS.services, ...FIELD_GROUPS.truck
];
const elements = Object.fromEntries([
  "search-form", "address-input", "radius-select", "locate-button", "search-message", "search-suggestions",
  "trip-toggle", "trip-panel", "trip-form", "trip-start", "trip-end", "fuel-filters", "service-filters",
  "fuel-match", "service-match", "clear-filters", "results-list", "results-summary", "result-count",
  "export-button", "detail-view", "site-detail", "back-button", "app-error", "sidebar", "mobile-map-button"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

let view;
let siteLayer;
let fieldNames = new Map();
let currentOrigin = null;
let currentResults = [];
let activeSite = null;
let searchSuggestions = [];
let suggestionTimer;
let suggestionRequest = 0;
let resultMode = "nearby";
let routeGeometry = null;
let routeDirections = null;
let mobileMapVisible = false;

function message(text) {
  elements.searchMessage.textContent = text;
}

function showError(text) {
  elements.appError.textContent = text;
  elements.appError.hidden = false;
}

function clearError() {
  elements.appError.hidden = true;
  elements.appError.textContent = "";
}

function actualField(key) {
  return fieldNames.get(key.toLowerCase()) || null;
}

function valueOf(feature, key) {
  const name = actualField(key);
  if (!name) return null;
  const attributes = feature.attributes || {};
  const attrName = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return attrName ? attributes[attrName] : null;
}

function isYes(value) {
  return value === true || value === 1 || ["yes", "true", "y", "1"].includes(String(value ?? "").trim().toLowerCase());
}

function pointFor(longitude, latitude) {
  return new Point({ longitude, latitude, spatialReference: { wkid: 4326 } });
}

function pointCoordinates(point) {
  return point ? { longitude: point.longitude ?? point.x, latitude: point.latitude ?? point.y } : null;
}

function distanceKm(first, second) {
  const a = pointCoordinates(first);
  const b = pointCoordinates(second);
  if (!a || !b) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function displayDistance(km) {
  if (!Number.isFinite(km)) return "";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function siteName(feature) {
  return String(valueOf(feature, "displayname") || "Fuel site").trim();
}

function siteAddress(feature) {
  return ["street", "suburb", "state", "postcode"]
    .map((key) => valueOf(feature, key))
    .filter((value) => value !== null && String(value).trim())
    .map((value) => String(value).trim())
    .join(", ");
}

function siteDistance(feature) {
  if (resultMode === "trip" && routeGeometry && feature.geometry) {
    return geometryEngine.distance(feature.geometry, routeGeometry, "kilometers");
  }
  return distanceKm(currentOrigin, feature.geometry);
}

function updateFilterChoices() {
  for (const [container, group] of [[elements.fuelFilters, FIELD_GROUPS.fuels], [elements.serviceFilters, FIELD_GROUPS.services]]) {
    const fragment = document.createDocumentFragment();
    for (const [key, label] of group) {
      if (!actualField(key)) continue;
      const wrapper = document.createElement("label");
      wrapper.className = "filter-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.field = key;
      input.addEventListener("change", renderResults);
      const text = document.createElement("span");
      text.textContent = label;
      wrapper.append(input, text);
      fragment.append(wrapper);
    }
    container.replaceChildren(fragment);
    if (!container.children.length) {
      const empty = document.createElement("span");
      empty.className = "filter-empty";
      empty.textContent = "No fields available";
      container.append(empty);
    }
  }
}

function selectedFilterKeys(container) {
  return [...container.querySelectorAll("input:checked")].map((input) => input.dataset.field);
}

function matchesFilterGroup(feature, keys, match) {
  if (!keys.length) return true;
  const matches = keys.map((key) => isYes(valueOf(feature, key)));
  return match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function filteredResults() {
  const fuelKeys = selectedFilterKeys(elements.fuelFilters);
  const serviceKeys = selectedFilterKeys(elements.serviceFilters);
  return currentResults.filter((feature) =>
    matchesFilterGroup(feature, fuelKeys, elements.fuelMatch.value) &&
    matchesFilterGroup(feature, serviceKeys, elements.serviceMatch.value)
  ).sort((a, b) => siteDistance(a) - siteDistance(b) || siteName(a).localeCompare(siteName(b)));
}

function renderResults() {
  const features = filteredResults();
  elements.resultsList.replaceChildren();
  elements.resultCount.textContent = features.length ? String(features.length) : "";
  if (!currentOrigin) {
    elements.resultsSummary.textContent = "Search an address or use your location to see nearby sites.";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<span class="empty-mark" aria-hidden="true">⌖</span><strong>Your next stop starts here</strong><span>Search anywhere in Australia or find sites near your current location.</span>';
    elements.resultsList.append(empty);
    return;
  }
  elements.resultsSummary.textContent = resultMode === "trip"
    ? `${features.length} ${features.length === 1 ? "site" : "sites"} within 1 km of your route`
    : `${features.length} ${features.length === 1 ? "site" : "sites"} within ${elements.radiusSelect.value} km`;
  if (resultMode === "trip" && routeDirections) {
    const summary = document.createElement("div");
    summary.className = "trip-route-card";
    const title = document.createElement("strong");
    title.textContent = "Your route";
    summary.append(title);
    showRouteDetails({ directions: routeDirections }, summary);
    elements.resultsList.append(summary);
  }
  if (!features.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = currentResults.length ? "No sites match these filters. Try changing your selections." : "No fuel sites found here. Try a wider radius or another location.";
    elements.resultsList.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  features.forEach((feature, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "result-card";
    card.addEventListener("click", () => openSite(feature));
    const number = document.createElement("span");
    number.className = "result-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const content = document.createElement("span");
    content.className = "result-content";
    const name = document.createElement("strong");
    name.textContent = siteName(feature);
    const address = document.createElement("span");
    address.textContent = siteAddress(feature) || "Address unavailable";
    const distance = document.createElement("span");
    distance.className = "result-distance";
    distance.textContent = resultMode === "trip" ? `${displayDistance(siteDistance(feature))} from route` : displayDistance(siteDistance(feature));
    content.append(name, address);
    card.append(number, content, distance);
    fragment.append(card);
  });
  elements.resultsList.append(fragment);
}

function clearMapGraphics() {
  if (!view) return;
  view.graphics.removeAll();
}

function renderMapGraphics() {
  if (!view) return;
  clearMapGraphics();
  if (currentOrigin) {
    view.graphics.add(new Graphic({
      geometry: currentOrigin,
      symbol: { type: "simple-marker", style: "circle", color: "#157f68", size: 15, outline: { color: "#fff", width: 3 } }
    }));
  }
  if (routeGeometry) {
    view.graphics.add(new Graphic({
      geometry: routeGeometry,
      symbol: { type: "simple-line", color: "#147e69", width: 5, style: "solid" }
    }));
  }
  for (const feature of currentResults) {
    if (!feature.geometry) continue;
    const siteIndex = currentResults.indexOf(feature);
    const marker = new Graphic({
      geometry: feature.geometry,
      attributes: { siteIndex },
      symbol: { type: "simple-marker", style: "circle", color: "#e3a339", size: 10, outline: { color: "#fff", width: 2 } }
    });
    view.graphics.add(marker);
  }
}

async function querySites(geometry) {
  const query = siteLayer.createQuery();
  query.where = "1=1";
  query.geometry = geometry;
  query.spatialRelationship = "intersects";
  query.returnGeometry = true;
  query.outFields = ["*"];
  query.outSpatialReference = { wkid: 4326 };
  query.num = 2000;
  const response = await siteLayer.queryFeatures(query);
  return response.features;
}

async function searchAround(point) {
  clearError();
  resetDetail();
  elements.resultsList.hidden = false;
  routeGeometry = null;
  routeDirections = null;
  currentOrigin = point;
  resultMode = "nearby";
  message("Finding nearby sites…");
  try {
    const radius = Number(elements.radiusSelect.value);
    const area = geometryEngine.geodesicBuffer(point, radius, "kilometers");
    currentResults = await querySites(area);
    renderResults();
    renderMapGraphics();
    await view.goTo({ target: area.extent, padding: { left: 30, right: 30, top: 40, bottom: 30 } });
    message(`${currentResults.length} sites found`);
  } catch (error) {
    console.error("Nearby fuel site search failed", error);
    message("Search could not be completed.");
    showError(`Could not search fuel sites. ${error.message || error}`);
  }
}

async function geocode(address) {
  const matches = await addressToLocations(GEOCODER_URL, {
    address: { SingleLine: address },
    countryCode: "AUS",
    forStorage: false,
    maxLocations: 1,
    outFields: ["Match_addr"]
  });
  if (!matches.length || !matches[0].location) throw new Error("No matching Australian address was found.");
  return matches[0].location;
}

function closeSuggestions() {
  elements.searchSuggestions.hidden = true;
  elements.addressInput.setAttribute("aria-expanded", "false");
}

function showSuggestions(suggestions) {
  searchSuggestions = suggestions;
  elements.searchSuggestions.replaceChildren();
  for (const suggestion of suggestions) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "suggestion";
    option.setAttribute("role", "option");
    option.textContent = suggestion.text;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      elements.addressInput.value = suggestion.text;
      closeSuggestions();
      searchAddress(suggestion.text, suggestion.magicKey);
    });
    elements.searchSuggestions.append(option);
  }
  elements.searchSuggestions.hidden = suggestions.length === 0;
  elements.addressInput.setAttribute("aria-expanded", String(suggestions.length > 0));
}

async function updateSuggestions(text) {
  const request = ++suggestionRequest;
  if (text.trim().length < 3) {
    closeSuggestions();
    return;
  }
  try {
    const suggestions = await suggestLocations(GEOCODER_URL, {
      text: text.trim(),
      countryCode: "AUS",
      forStorage: false,
      maxSuggestions: 5
    });
    if (request !== suggestionRequest || elements.addressInput.value.trim() !== text.trim()) return;
    showSuggestions(suggestions);
  } catch (error) {
    console.error("Australian address suggestions failed", error);
    closeSuggestions();
  }
}

async function searchAddress(address, magicKey) {
  if (!address.trim()) return;
  closeSuggestions();
  clearError();
  message("Finding address…");
  try {
    let point;
    if (magicKey) {
      const matches = await addressToLocations(GEOCODER_URL, {
        address: { SingleLine: address },
        magicKey,
        countryCode: "AUS",
        forStorage: false,
        maxLocations: 1,
        outFields: ["Match_addr"]
      });
      point = matches[0]?.location;
    } else {
      point = await geocode(address);
    }
    if (!point) throw new Error("No matching Australian address was found.");
    await searchAround(point);
  } catch (error) {
    console.error("Address search failed", error);
    message("Address not found.");
    showError(error.message || "Could not find that address.");
  }
}

function resetDetail() {
  activeSite = null;
  elements.detailView.hidden = true;
}

function makeDetailSection(title, items, className = "") {
  if (!items.length) return null;
  const section = document.createElement("section");
  section.className = `detail-section ${className}`.trim();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("div");
  list.className = "detail-items";
  for (const item of items) {
    const entry = document.createElement("span");
    entry.textContent = item;
    list.append(entry);
  }
  section.append(heading, list);
  return section;
}

function openSite(feature) {
  activeSite = feature;
  elements.detailView.hidden = false;
  elements.resultsList.hidden = true;
  const detail = elements.siteDetail;
  detail.replaceChildren();
  const status = String(valueOf(feature, "status") || "").trim().toLowerCase();
  if (status === "temp closure" || status === "closed") {
    const banner = document.createElement("div");
    banner.className = "closed-banner";
    banner.textContent = "Temporarily closed";
    const from = formatDate(valueOf(feature, "temp_closed_from"));
    const to = formatDate(valueOf(feature, "temp_closed_to"));
    if (from || to) {
      const dates = document.createElement("small");
      dates.textContent = [from && `From ${from}`, to && `to ${to}`].filter(Boolean).join(" ");
      banner.append(dates);
    }
    detail.append(banner);
  } else if (status === "open") {
    const badge = document.createElement("div");
    badge.className = "open-banner";
    badge.textContent = "Open";
    detail.append(badge);
  }
  const name = document.createElement("h2");
  name.className = "detail-name";
  name.textContent = siteName(feature);
  const address = document.createElement("p");
  address.className = "detail-address";
  address.textContent = siteAddress(feature) || "Address unavailable";
  detail.append(name, address);
  const phone = valueOf(feature, "phone");
  if (phone) {
    const phoneLink = document.createElement("a");
    phoneLink.className = "phone-link";
    phoneLink.href = `tel:${String(phone).replace(/[^\d+]/g, "")}`;
    phoneLink.textContent = String(phone);
    detail.append(phoneLink);
  }
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const directions = document.createElement("button");
  directions.type = "button";
  directions.className = "primary-button";
  directions.textContent = "Get directions";
  directions.addEventListener("click", () => getDirections(feature));
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "secondary-button";
  zoom.textContent = "Zoom to site";
  zoom.addEventListener("click", () => {
    if (feature.geometry) view.goTo({ target: feature.geometry, zoom: 14 });
  });
  actions.append(directions, zoom);
  detail.append(actions);

  const hours = [];
  if (isYes(valueOf(feature, "open_24_hours"))) {
    hours.push("Open 24 hours");
  } else {
    for (let index = 0; index < DAY_NAMES.length; index++) {
      const key = DAY_NAMES[index].slice(0, 3).toLowerCase();
      const opening = valueOf(feature, `${key}_opening`);
      const closing = valueOf(feature, `${key}_closing`);
      if (opening || closing) hours.push(`${DAY_NAMES[index]}: ${opening || "—"}–${closing || "—"}`);
    }
  }
  const hoursSection = makeDetailSection("Trading hours", hours);
  if (hoursSection) detail.append(hoursSection);
  const types = FIELD_GROUPS.fuels.filter(([key]) => isYes(valueOf(feature, key))).map(([, label]) => label);
  const services = FIELD_GROUPS.services.filter(([key]) => isYes(valueOf(feature, key))).map(([, label]) => label);
  const truck = FIELD_GROUPS.truck.filter(([key]) => isYes(valueOf(feature, key))).map(([, label]) => label);
  const fuelsSection = makeDetailSection("Fuel types", types, "fuel-items");
  const servicesSection = makeDetailSection("Services", services);
  const truckSection = makeDetailSection("Truck access", truck);
  for (const section of [fuelsSection, servicesSection, truckSection]) if (section) detail.append(section);
  if (!elements.searchMessage.textContent) message("");
}

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(date);
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return "";
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  return hours ? `${hours} hr ${remaining} min` : `${remaining} min`;
}

function drawRoute(routeResult) {
  routeGeometry = routeResult.route.geometry;
  routeDirections = routeResult.directions;
  renderMapGraphics();
}

async function calculateRoute(start, end) {
  const stops = new FeatureSet({
    features: [
      new Graphic({ geometry: start }),
      new Graphic({ geometry: end })
    ]
  });
  const params = new RouteParameters({
    stops,
    findBestSequence: false,
    preserveFirstStop: true,
    preserveLastStop: true,
    returnDirections: true,
    directionsLengthUnits: "kilometers",
    outSpatialReference: { wkid: 4326 }
  });
  const result = await solve(ROUTE_URL, params);
  const routeResult = result.routeResults?.[0];
  if (!routeResult?.route?.geometry) throw new Error("No route could be found between these locations.");
  return routeResult;
}

function showRouteDetails(routeResult, container) {
  const directionsData = routeResult.directions;
  const summary = document.createElement("div");
  summary.className = "route-summary";
  const length = Number(directionsData?.totalLength);
  const time = Number(directionsData?.totalTime);
  summary.textContent = [Number.isFinite(length) ? `${length.toFixed(1)} km` : "", formatDuration(time)]
    .filter(Boolean).join(" · ");
  container.append(summary);
  const steps = directionsData?.features || [];
  if (!steps.length) return;
  const list = document.createElement("ol");
  list.className = "turn-list";
  for (const feature of steps) {
    const item = document.createElement("li");
    const attrs = feature.attributes || {};
    item.textContent = attrs.text || attrs.displayText || "Continue along route";
    list.append(item);
  }
  container.append(list);
}

async function getDirections(feature) {
  if (!currentOrigin || !feature.geometry) {
    showError("Search for an address or use your location before requesting directions.");
    return;
  }
  clearError();
  message("Calculating directions…");
  try {
    const result = await calculateRoute(currentOrigin, feature.geometry);
    drawRoute(result);
    await view.goTo({ target: result.route.geometry, padding: 50 });
    const directionsPanel = document.createElement("section");
    directionsPanel.className = "directions-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Route directions";
    directionsPanel.append(heading);
    showRouteDetails(result, directionsPanel);
    elements.siteDetail.querySelector(".directions-panel")?.remove();
    elements.siteDetail.append(directionsPanel);
    message("Route ready");
  } catch (error) {
    console.error("Route calculation failed", error);
    message("Directions unavailable.");
    showError(`Could not calculate directions. ${error.message || error}`);
  }
}

async function planTrip(event) {
  event.preventDefault();
  const startText = elements.tripStart.value.trim();
  const endText = elements.tripEnd.value.trim();
  if (!startText || !endText) return;
  clearError();
  message("Planning your trip…");
  try {
    const [start, end] = await Promise.all([geocode(startText), geocode(endText)]);
    const result = await calculateRoute(start, end);
    drawRoute(result);
    resetDetail();
    elements.resultsList.hidden = false;
    currentOrigin = start;
    resultMode = "trip";
    const corridor = geometryEngine.geodesicBuffer(result.route.geometry, 1, "kilometers");
    currentResults = await querySites(corridor);
    renderResults();
    renderMapGraphics();
    await view.goTo({ target: result.route.geometry, padding: { left: 35, right: 35, top: 50, bottom: 50 } });
    message(`${currentResults.length} sites along your trip`);
  } catch (error) {
    console.error("Trip planning failed", error);
    message("Trip could not be planned.");
    showError(`Could not plan this trip. ${error.message || error}`);
  }
}

function exportPdf() {
  const PDF = window.jspdf?.jsPDF;
  if (!PDF) {
    showError("PDF export could not load. Check your connection and try again.");
    return;
  }
  try {
    const features = filteredResults();
    const doc = new PDF({ unit: "mm", format: "a4" });
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 18;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("Fuel finder · Search results", 15, y);
    y += 9;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const label = resultMode === "trip" ? `${elements.tripStart.value} to ${elements.tripEnd.value}` : elements.addressInput.value.trim() || "My location";
    doc.text(doc.splitTextToSize(`Search: ${label}`, 180), 15, y);
    y += 6;
    doc.text(`${features.length} sites · ${resultMode === "trip" ? "within 1 km of route" : `within ${elements.radiusSelect.value} km`}`, 15, y);
    y += 10;
    if (!features.length) doc.text("No sites match the current search and filters.", 15, y);
    for (const feature of features) {
      const rows = [siteName(feature), siteAddress(feature) || "Address unavailable",
        `Distance: ${displayDistance(siteDistance(feature))}`,
        ...FIELD_GROUPS.fuels.filter(([key]) => isYes(valueOf(feature, key))).map(([, name]) => name)];
      const wrapped = rows.flatMap((row) => doc.splitTextToSize(row, 175));
      const height = wrapped.length * 5 + 8;
      if (y + height > pageHeight - 15) {
        doc.addPage();
        y = 18;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(wrapped[0], 15, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(wrapped.slice(1), 15, y + 5);
      y += height;
      doc.setDrawColor(220);
      doc.line(15, y - 3, 195, y - 3);
    }
    doc.save("fuel-finder-results.pdf");
  } catch (error) {
    console.error("PDF export failed", error);
    showError(`Could not export the current results as a PDF. ${error.message || error}`);
  }
}

function toggleMap() {
  mobileMapVisible = !mobileMapVisible;
  elements.sidebar.classList.toggle("map-visible", mobileMapVisible);
  elements.mobileMapButton.textContent = mobileMapVisible ? "Back to search" : "View map";
  if (mobileMapVisible && view) view.resize();
}

async function initialize() {
  let config;
  try {
    config = await import("./config.js");
  } catch (error) {
    console.error("ArcGIS configuration module is missing", error);
    showError("Add your ArcGIS API key to config.js (see config.example.js) to load the map and search.");
    message("Setup required");
    return;
  }
  if (!config.ARCGIS_API_KEY || !config.ARCGIS_API_KEY.trim()) {
    showError("Add your ArcGIS API key to config.js (see config.example.js) to load the map and search.");
    message("Setup required");
    return;
  }
  esriConfig.apiKey = config.ARCGIS_API_KEY.trim();
  try {
    const map = new ArcGISMap({ basemap: "arcgis/streets" });
    view = new MapView({
      container: "map-view-container",
      map,
      center: [134, -25],
      zoom: 4,
      constraints: { minZoom: 3 }
    });
    siteLayer = new FeatureLayer({ url: FEATURE_LAYER_URL, apiKey: config.ARCGIS_API_KEY.trim() });
    await Promise.all([view.when(), siteLayer.load()]);
    for (const field of siteLayer.fields || []) fieldNames.set(field.name.toLowerCase(), field.name);
    for (const [key] of DETAIL_FIELDS) {
      if (!actualField(key)) console.warn(`Fuel site service is missing expected field "${key}"; skipping it.`);
    }
    updateFilterChoices();
    view.on("click", async (event) => {
      const hit = await view.hitTest(event);
      const marker = hit.results.find((result) => Number.isInteger(result.graphic?.attributes?.siteIndex));
      if (marker) {
        const match = currentResults[marker.graphic.attributes.siteIndex];
        if (match) openSite(match);
      }
    });
    clearError();
    message("");
  } catch (error) {
    console.error("Fuel finder initialization failed", error);
    showError(`Could not load the map or fuel site fields. ${error.message || error}`);
    message("Map unavailable");
  }
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchAddress(elements.addressInput.value);
});
elements.addressInput.addEventListener("input", () => {
  window.clearTimeout(suggestionTimer);
  const text = elements.addressInput.value;
  suggestionTimer = window.setTimeout(() => updateSuggestions(text), 240);
});
elements.addressInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSuggestions();
});
elements.addressInput.addEventListener("blur", () => window.setTimeout(closeSuggestions, 120));
elements.radiusSelect.addEventListener("change", () => {
  if (currentOrigin && resultMode === "nearby") searchAround(currentOrigin);
});
elements.locateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showError("Your browser does not support location services.");
    return;
  }
  clearError();
  message("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => searchAround(pointFor(coords.longitude, coords.latitude)),
    (error) => {
      console.error("Browser geolocation failed", error);
      message("Location unavailable.");
      showError(error.code === error.PERMISSION_DENIED
        ? "Location access was declined. Search for an address instead."
        : "Could not get your location. Check your device settings and try again.");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});
elements.tripToggle.addEventListener("click", () => {
  const expanded = elements.tripToggle.getAttribute("aria-expanded") === "true";
  elements.tripToggle.setAttribute("aria-expanded", String(!expanded));
  elements.tripPanel.hidden = expanded;
});
elements.tripForm.addEventListener("submit", planTrip);
elements.fuelMatch.addEventListener("change", renderResults);
elements.serviceMatch.addEventListener("change", renderResults);
elements.clearFilters.addEventListener("click", () => {
  document.querySelectorAll(".filter-options input[type=checkbox]").forEach((input) => { input.checked = false; });
  elements.fuelMatch.value = "any";
  elements.serviceMatch.value = "any";
  renderResults();
});
elements.exportButton.addEventListener("click", exportPdf);
elements.backButton.addEventListener("click", () => {
  resetDetail();
  elements.resultsList.hidden = false;
});
elements.mobileMapButton.addEventListener("click", toggleMap);

renderResults();
initialize();
