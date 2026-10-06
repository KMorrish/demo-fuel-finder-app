import WebMap from "https://js.arcgis.com/4.32/@arcgis/core/WebMap.js";
import MapView from "https://js.arcgis.com/4.32/@arcgis/core/views/MapView.js";
import { addressToLocations, suggestLocations } from "https://js.arcgis.com/4.32/@arcgis/core/rest/locator.js";
import Graphic from "https://js.arcgis.com/4.32/@arcgis/core/Graphic.js";
import * as geometryEngine from "https://js.arcgis.com/4.32/@arcgis/core/geometry/geometryEngine.js";

(() => {
  const WEBMAP_ID = "cee7757ff62743b2b26013e560914faa";
  const GEOCODER_URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer";
  const TRUE_VALUES = new Set(["1", "true", "yes", "y", "available", "on"]);
  const FALSE_VALUES = new Set(["0", "false", "no", "n", "unavailable", "off", ""]);
  const systemFields = new Set(["objectid", "fid", "shape", "shape_length", "shape_area", "globalid"]);
  const serviceTerms = /\b(amenit|service|atm|gift|payment|open 24|24 hour|restaurant|shop|toilet\w*|shower\w*|car ?wash|air pump|truck|forecourt|high flow|parking|wifi|coffee|food|lubric|oil|adblue|urea|viva|promo|card|national diesel chain|ev charg|electric|baby change|playground|disabled|accessible|weighbridge|trailer|b double|road train)\b/i;
  const fuelTerms = /\b(fuel|unleaded|diesel|petrol|v-power|premium|premi\w*max|autogas|lpg|e10|biofuel|ethanol|octane|adblue)\b/i;
  const lubricantTerms = /\b(lubric|oil|grease)\b/i;
  const truckTerms = /\b(truck|forecourt|high flow|ultra high flow|weighbridge|trailer|b double|road train|accessible)\b/i;

    const elements = {
      form: document.getElementById("search-form"),
      address: document.getElementById("address-input"),
      radius: document.getElementById("radius-select"),
      clear: document.getElementById("clear-search"),
      reset: document.getElementById("reset-search"),
      suggestions: document.getElementById("search-suggestions"),
      message: document.getElementById("search-message"),
      error: document.getElementById("app-error"),
      results: document.getElementById("results-list"),
      summary: document.getElementById("results-summary"),
      count: document.getElementById("result-count"),
      productFilters: document.getElementById("product-filters"),
      serviceFilters: document.getElementById("service-filters"),
      productEmpty: document.getElementById("product-empty"),
      serviceEmpty: document.getElementById("service-empty"),
      detail: document.getElementById("site-detail"),
      export: document.getElementById("export-button"),
      sidebar: document.querySelector(".sidebar")
    };

    const webmap = new WebMap({ portalItem: { id: WEBMAP_ID } });
    const view = new MapView({
      container: "map-view-container",
      map: webmap,
      popup: { dockEnabled: true, dockOptions: { position: "bottom-right", breakpoint: false } }
    });
    let layers = [];
    let filterFields = { products: [], services: [] };
    const fieldLayers = new WeakMap();
    const featureLayers = new WeakMap();
    const featureDistances = new WeakMap();
    let activeProductCategory = "fuel";
    let currentLocation = null;
    let currentResults = [];
    let suggestionTimer = null;
    let suggestionRequest = 0;
    let activeSuggestion = -1;
    let searchSuggestions = [];

    function showError(message) {
      elements.error.textContent = message;
      elements.error.hidden = false;
    }

    function setMessage(message) {
      elements.message.textContent = message;
    }

    function closeSuggestions() {
      elements.suggestions.hidden = true;
      elements.address.setAttribute("aria-expanded", "false");
      elements.address.removeAttribute("aria-activedescendant");
      activeSuggestion = -1;
    }

    function renderSuggestions(suggestions) {
      searchSuggestions = suggestions;
      activeSuggestion = -1;
      elements.suggestions.replaceChildren();
      for (const [index, suggestion] of suggestions.entries()) {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `search-suggestion-${index}`;
        option.className = "search-suggestion";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.append(document.createTextNode(suggestion.label));
        const kind = document.createElement("small");
        kind.textContent = suggestion.kind === "site" ? "Fuel site" : "Suburb or address";
        option.append(kind);
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => selectSuggestion(index));
        elements.suggestions.append(option);
      }
      elements.suggestions.hidden = suggestions.length === 0;
      elements.address.setAttribute("aria-expanded", String(suggestions.length > 0));
    }

    function setActiveSuggestion(index) {
      if (!searchSuggestions.length) return;
      activeSuggestion = (index + searchSuggestions.length) % searchSuggestions.length;
      for (const [optionIndex, option] of Array.from(elements.suggestions.children).entries()) {
        const active = optionIndex === activeSuggestion;
        option.classList.toggle("active", active);
        option.setAttribute("aria-selected", String(active));
      }
      elements.address.setAttribute("aria-activedescendant", `search-suggestion-${activeSuggestion}`);
      elements.suggestions.children[activeSuggestion].scrollIntoView({ block: "nearest" });
    }

    async function findSiteSuggestions(text) {
      const clausesByLayer = layers.map((layer) => {
        const fields = identifySiteFields(layer);
        const searchable = [fields.name, fields.address, fields.suburb, fields.postcode].filter(Boolean);
        const terms = [];
        const value = text.replace(/[%_]/g, "").replace(/'/g, "''");
        if (!value) return { layer, where: "" };
        for (const field of searchable) {
          if (field.type === "string") {
            terms.push(`${field.name} LIKE '%${value}%'`);
          } else if (field === fields.postcode && /^\d{1,4}$/.test(text)) {
            const postcodePrefix = Number(text);
            const rangeSize = 10 ** (4 - text.length);
            terms.push(`(${field.name} >= ${postcodePrefix * rangeSize} AND ${field.name} <= ${(postcodePrefix + 1) * rangeSize - 1})`);
          }
        }
        return { layer, where: terms.length ? terms.join(" OR ") : "" };
      }).filter((entry) => entry.where);
      const queried = await Promise.all(clausesByLayer.map(async ({ layer, where }) => {
        const query = layer.createQuery();
        query.where = where;
        query.outFields = ["*"];
        query.returnGeometry = true;
        query.num = 8;
        const result = await layer.queryFeatures(query);
        for (const feature of result.features) featureLayers.set(feature, layer.id);
        return result.features;
      }));
      const seen = new Set();
      return queried.flat().flatMap((feature) => {
        const name = siteName(feature);
        const address = siteAddress(feature);
        const key = `${name}|${address}`.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          kind: "site",
          label: [name, address].filter(Boolean).join(" — "),
          feature
        }];
      }).slice(0, 6);
    }

    async function findExactSite(text) {
      const value = text.replace(/'/g, "''");
      const queries = layers.flatMap((layer) => {
        const name = identifySiteFields(layer).name;
        if (!name || name.type !== "string") return [];
        return [async () => {
          const query = layer.createQuery();
          query.where = `${name.name} = '${value}'`;
          query.outFields = ["*"];
          query.returnGeometry = true;
          query.num = 1;
          const result = await layer.queryFeatures(query);
          for (const feature of result.features) featureLayers.set(feature, layer.id);
          return result.features[0] || null;
        }];
      });
      const matches = await Promise.all(queries.map((query) => query()));
      return matches.find(Boolean) || null;
    }

    async function updateSuggestions(text) {
      const request = ++suggestionRequest;
      const normalized = text.trim();
      if (normalized.length < 2) {
        closeSuggestions();
        return;
      }
      const [locations, sites] = await Promise.allSettled([
        suggestLocations(GEOCODER_URL, {
          text: normalized,
          countryCode: "AUS",
          maxSuggestions: 5
        }),
        findSiteSuggestions(normalized)
      ]);
      if (request !== suggestionRequest || elements.address.value.trim() !== normalized) return;
      const failures = [locations, sites].filter((result) => result.status === "rejected");
      if (locations.status === "rejected") console.error("Location autocomplete failed", locations.reason);
      if (sites.status === "rejected") console.error("Site autocomplete failed", sites.reason);
      const locationSuggestions = locations.status === "fulfilled"
        ? locations.value.slice(0, 4).map((item) => ({ kind: "location", label: item.text, magicKey: item.magicKey }))
        : [];
      const siteSuggestions = sites.status === "fulfilled" ? sites.value.slice(0, 4) : [];
      renderSuggestions([...siteSuggestions, ...locationSuggestions].slice(0, 8));
      if (failures.length === 2) {
        showError("Search suggestions are unavailable. You can still submit a search.");
      } else {
        elements.error.hidden = true;
      }
    }

    function selectSuggestion(index) {
      const suggestion = searchSuggestions[index];
      if (!suggestion) return;
      closeSuggestions();
      elements.address.value = suggestion.label;
      if (suggestion.kind === "site") {
        searchSite(suggestion.feature);
      } else {
        searchAddress(suggestion.label, suggestion.magicKey);
      }
    }

    async function searchSite(feature) {
      if (!feature.geometry) {
        setMessage("This site has no location available.");
        return;
      }
      try {
        elements.error.hidden = true;
        currentLocation = feature.geometry;
        featureDistances.set(feature, 0);
        view.graphics.removeAll();
        view.graphics.add(new Graphic({
          geometry: currentLocation,
          symbol: { type: "simple-marker", style: "circle", color: "#ffcf21", size: 17, outline: { color: "#fff", width: 2 } }
        }));
        await view.goTo({ target: currentLocation, zoom: elements.radius.value ? 9 : 12 });
        await refreshResults();
      } catch (error) {
        console.error("Site search failed", error);
        setMessage("Could not open that site location.");
        showError(`Site search failed: ${error.message || error}`);
      }
    }

    function getValue(attributes, field) {
      if (Object.prototype.hasOwnProperty.call(attributes, field.name)) return attributes[field.name];
      const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === field.name.toLowerCase());
      return key ? attributes[key] : null;
    }

    function isPresent(value) {
      if (value === null || value === undefined) return false;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      const text = String(value).trim().toLowerCase();
      if (FALSE_VALUES.has(text)) return false;
      if (TRUE_VALUES.has(text)) return true;
      return text.length > 0;
    }

    function fieldLabel(field) {
      const label = (field.alias || field.name).replace(/_/g, " ");
      return label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
        .replace(/\bAtm\b/g, "ATM")
        .replace(/\bAdblue\b/g, "AdBlue")
        .replace(/\bAutogas\b/g, "AutoGas LPG")
        .replace(/\bCarwash\b/g, "Car Wash")
        .replace(/\bB Double\b/g, "B-Double")
        .replace(/\bSemi Trailer\b/g, "Semi-trailer")
        .replace(/\bHigh Flow Diesel\b/g, "Diesel - High Flow")
        .replace(/\bRetail Shop\b/g, "Shop");
    }

    function fieldText(field) {
      return `${field.alias || ""} ${field.name}`
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ");
    }

    function isSystemField(field) {
      return systemFields.has(field.name.toLowerCase()) || field.type === "geometry" ||
        field.type === "oid" || field.name.toLowerCase().startsWith("shape_") ||
        /\bbrand\b/i.test(fieldText(field));
    }

    function classifyFields() {
      const productCandidates = [];
      const serviceCandidates = [];
      for (const layer of layers) {
        for (const field of layer.fields || []) {
          if (isSystemField(field) || field.type === "date") continue;
          const label = fieldText(field);
          if (lubricantTerms.test(label) || /\badblue\b/i.test(label)) {
            productCandidates.push(field);
          } else if (serviceTerms.test(label)) {
            serviceCandidates.push(field);
          } else if (fuelTerms.test(label)) {
            productCandidates.push(field);
          }
        }
      }
      const uniqueByName = (fields) => Array.from(new Map(fields.map((field) => [
        `${fieldLayers.get(field)}:${field.name.toLowerCase()}`,
        field
      ])).values());
      filterFields.products = uniqueByName(productCandidates);
      filterFields.services = uniqueByName(serviceCandidates);
      renderFieldFilters();
    }

    function renderFieldFilters() {
      const makeCheckbox = (field, type) => {
        const label = document.createElement("label");
        label.className = "filter-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.field = field.name;
        input.dataset.layer = fieldLayers.get(field);
        input.dataset.kind = type;
        input.addEventListener("change", updateResults);
        const text = document.createElement("span");
        text.textContent = fieldLabel(field);
        label.append(input, text);
        return label;
      };
      elements.productFilters.replaceChildren(...filterFields.products.map((field) => makeCheckbox(field, "products")));
      elements.serviceFilters.replaceChildren(...filterFields.services.map((field) => makeCheckbox(field, "services")));
      elements.productEmpty.hidden = filterFields.products.length !== 0;
      elements.serviceEmpty.hidden = filterFields.services.length !== 0;
      updateCategoryVisibility();
    }

    function updateCategoryVisibility() {
      for (const input of elements.productFilters.querySelectorAll("input")) {
        const field = filterFields.products.find((item) => item.name === input.dataset.field);
        const label = input.closest("label");
        const name = field ? fieldText(field) : "";
        const matches = activeProductCategory === "lubricants"
          ? lubricantTerms.test(name)
          : activeProductCategory === "truck"
            ? truckTerms.test(name)
            : !lubricantTerms.test(name) && !truckTerms.test(name);
        label.hidden = !matches;
      }
      const isTruckView = activeProductCategory === "truck";
      document.getElementById("product-heading").hidden = isTruckView;
      document.getElementById("product-filter-options").hidden = isTruckView;
      const visibleProducts = filterFields.products.filter((field) => {
        const name = fieldText(field);
        return activeProductCategory === "lubricants"
          ? lubricantTerms.test(name)
          : activeProductCategory === "truck"
            ? truckTerms.test(name)
            : !lubricantTerms.test(name) && !truckTerms.test(name);
      });
      elements.productEmpty.textContent = activeProductCategory === "lubricants"
        ? "No lubricant fields were found in the map layer."
        : "No product fields were found in the map layer.";
      elements.productEmpty.hidden = isTruckView || visibleProducts.length > 0;
      const serviceHeading = document.querySelector("#service-heading em");
      serviceHeading.textContent = isTruckView ? "Truck Friendly Services" : "Services & Amenities";
      const visibleServices = filterFields.services.filter((field) =>
        !isTruckView || truckTerms.test(fieldText(field))
      );
      elements.serviceEmpty.textContent = isTruckView
        ? "No truck-friendly service fields were found in the map layer."
        : "No service or amenity fields were found in the map layer.";
      elements.serviceEmpty.hidden = visibleServices.length > 0;
      for (const input of elements.serviceFilters.querySelectorAll("input")) {
        const field = filterFields.services.find((item) => item.name === input.dataset.field);
        input.closest("label").hidden = isTruckView && !(field && truckTerms.test(fieldText(field)));
      }
    }

    function checkedFields(kind) {
      return Array.from(document.querySelectorAll(`input[data-kind="${kind}"]:checked`))
        .filter((input) => !input.closest("label").hidden);
    }

    function featureLayer(feature) {
      return layers.find((item) => String(item.id) === String(featureLayers.get(feature)));
    }

    function featureDistance(feature) {
      return featureDistances.get(feature) ?? null;
    }

    function matchesGroup(feature, checked, matchAll) {
      const applicable = checked.filter((input) => String(input.dataset.layer) === String(featureLayers.get(feature)));
      if (!applicable.length) return true;
      const values = applicable.map((input) => {
        const layer = layers.find((item) => String(item.id) === input.dataset.layer);
        const field = layer?.fields.find((item) => item.name === input.dataset.field);
        return field ? isPresent(getValue(feature.attributes, field)) : false;
      });
      return matchAll ? values.every(Boolean) : values.some(Boolean);
    }

    function applyFilters(features) {
      const products = checkedFields("products");
      const services = checkedFields("services");
      const productsAll = document.getElementById("products-match-all").checked;
      const servicesAll = document.getElementById("services-match-all").checked;
      return features.filter((feature) =>
        matchesGroup(feature, products, productsAll) && matchesGroup(feature, services, servicesAll)
      );
    }

    function findField(layer, patterns) {
      const fields = layer.fields || [];
      return fields.find((field) => patterns.some((pattern) => pattern.test(fieldText(field))));
    }

    function identifySiteFields(layer) {
      return {
        name: findField(layer, [/\b(site|station|business|trading)\s*name\b/i, /\bname\b|displayname/i, /facility\s*name/i]),
        address: findField(layer, [/\baddress\b/i, /street/i]),
        suburb: findField(layer, [/\b(suburb|locality|town|city)\b/i]),
        state: findField(layer, [/\bstate\b/i]),
        postcode: findField(layer, [/\b(postcode|postal\s*code|zip)\b/i]),
        phone: findField(layer, [/\b(phone|telephone|contact)\b/i])
      };
    }

    function attribute(feature, field) {
      if (!field) return "";
      const layer = featureLayer(feature);
      const actualField = layer?.fields.find((item) => item.name === field.name) || field;
      const value = getValue(feature.attributes, actualField);
      return value === null || value === undefined ? "" : String(value).trim();
    }

    function siteName(feature) {
      const layer = featureLayer(feature);
      return attribute(feature, identifySiteFields(layer).name) || "Fuel site";
    }

    function siteAddress(feature) {
      const layer = featureLayer(feature);
      const fields = identifySiteFields(layer);
      return [fields.address, fields.suburb, fields.state, fields.postcode]
        .map((field) => attribute(feature, field))
        .filter(Boolean)
        .join(", ");
    }

    function checkedAmenities(feature, kind) {
      const fields = (kind === "products" ? filterFields.products : filterFields.services)
        .filter((field) => String(fieldLayers.get(field)) === String(featureLayers.get(feature)));
      return fields.filter((field) => isPresent(getValue(feature.attributes, field)))
        .map((field) => fieldLabel(field));
    }

    function distanceInKm(geometry) {
      if (!currentLocation || !geometry) return null;
      const latitude1 = currentLocation.latitude * Math.PI / 180;
      const latitude2 = geometry.latitude * Math.PI / 180;
      const latitudeDelta = latitude2 - latitude1;
      const longitudeDelta = (geometry.longitude - currentLocation.longitude) * Math.PI / 180;
      const haversine = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
      return 6371.0088 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    function formatDistance(km) {
      return km === null ? "" : `${km.toFixed(3)} km`;
    }

    function renderResults() {
      const filtered = applyFilters(currentResults);
      filtered.sort((a, b) => (featureDistance(a) ?? Infinity) - (featureDistance(b) ?? Infinity));
      elements.results.replaceChildren();
      elements.count.textContent = filtered.length ? String(filtered.length) : "";
      elements.summary.textContent = currentLocation
        ? `${filtered.length} ${filtered.length === 1 ? "site" : "sites"} found${elements.radius.value ? ` within ${elements.radius.value} km` : ""}`
        : "Search for an address to find nearby sites.";
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "no-results";
        empty.textContent = currentLocation
          ? "No sites match this search. Try a larger radius or remove some filters."
          : "Search for an address to find nearby sites.";
        elements.results.append(empty);
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const feature of filtered) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "result-card";
        button.addEventListener("click", () => openDetail(feature));
        const name = document.createElement("span");
        name.className = "result-name";
        name.textContent = siteName(feature);
        const address = document.createElement("span");
        address.className = "result-address";
        address.textContent = siteAddress(feature);
        const distance = document.createElement("span");
        distance.className = "result-distance";
        distance.textContent = formatDistance(featureDistance(feature));
        const chevron = document.createElement("span");
        chevron.className = "result-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "›";
        button.append(name, address, distance, chevron);
        fragment.append(button);
      }
      elements.results.append(fragment);
    }

    function openDetail(feature) {
      const layer = featureLayer(feature);
      const fields = identifySiteFields(layer);
      elements.detail.replaceChildren();

      const brand = document.createElement("div");
      brand.className = "site-brand";
      brand.textContent = "Fuel locator";
      const title = document.createElement("h2");
      title.className = "detail-name";
      title.textContent = siteName(feature);
      const address = document.createElement("p");
      address.className = "detail-address";
      address.textContent = siteAddress(feature);
      const distance = document.createElement("p");
      distance.className = "detail-distance";
      distance.textContent = formatDistance(featureDistance(feature));
      elements.detail.append(brand, title, address, distance);

      const phone = attribute(feature, fields.phone);
      if (phone) {
        const phoneLink = document.createElement("a");
        phoneLink.className = "detail-phone";
        phoneLink.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
        phoneLink.textContent = `♧  ${phone}`;
        elements.detail.append(phoneLink);
      }

      const actions = document.createElement("div");
      actions.className = "detail-actions";
      const directions = document.createElement("a");
      directions.className = "primary-button";
      directions.textContent = "Directions";
      const coordinates = feature.geometry ? `${feature.geometry.latitude},${feature.geometry.longitude}` : "";
      directions.href = coordinates ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coordinates)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(siteAddress(feature))}`;
      directions.target = "_blank";
      directions.rel = "noopener noreferrer";
      const zoom = document.createElement("button");
      zoom.className = "primary-button";
      zoom.type = "button";
      zoom.textContent = "Zoom to Site";
      zoom.addEventListener("click", () => zoomTo(feature));
      actions.append(directions, zoom);
      elements.detail.append(actions);

      addDetailSection("Services & Amenities", checkedAmenities(feature, "services"), false);
      addDetailSection("Fuel Types", checkedAmenities(feature, "products"), true);
      showPanel("detail");
    }

    function addDetailSection(titleText, items, isFuel) {
      if (!items.length) return;
      const section = document.createElement("section");
      section.className = `detail-section${isFuel ? " fuels" : ""}`;
      const heading = document.createElement("h3");
      heading.textContent = titleText;
      const list = document.createElement("div");
      list.className = "detail-attributes";
      for (const item of items) {
        const entry = document.createElement("span");
        entry.className = "detail-attribute";
        entry.textContent = item;
        list.append(entry);
      }
      section.append(heading, list);
      elements.detail.append(section);
    }

    function zoomTo(feature) {
      if (!feature.geometry) return;
      view.goTo({ target: feature.geometry, zoom: 15 });
      showPanel("map");
      if (window.matchMedia("(max-width: 720px)").matches) elements.sidebar.classList.add("map-active");
    }

    function showPanel(name) {
      for (const panel of document.querySelectorAll(".panel-view")) panel.classList.remove("active");
      const target = document.getElementById(`${name}-view`);
      if (target) target.classList.add("active");
      for (const tab of document.querySelectorAll(".view-tab")) {
        tab.classList.toggle("active", tab.dataset.view === name);
      }
      if (name === "results" || name === "filters") {
        elements.sidebar.classList.remove("map-active");
      }
    }

    function updateResults() {
      renderResults();
    }

    async function queryLayer(layer, geometry) {
      const query = layer.createQuery();
      query.geometry = geometry || undefined;
      query.spatialRelationship = "intersects";
      query.returnGeometry = true;
      query.outFields = ["*"];
      query.where = "1=1";
      query.outSpatialReference = currentLocation?.spatialReference || view.spatialReference;
      const objectIds = await layer.queryObjectIds(query);
      if (!objectIds?.length) return [];
      const output = [];
      for (let index = 0; index < objectIds.length; index += 500) {
        const page = layer.createQuery();
        page.objectIds = objectIds.slice(index, index + 500);
        page.returnGeometry = true;
        page.outFields = ["*"];
        page.outSpatialReference = currentLocation?.spatialReference || view.spatialReference;
        const result = await layer.queryFeatures(page);
        for (const feature of result.features) {
          featureLayers.set(feature, layer.id);
          featureDistances.set(feature, distanceInKm(feature.geometry));
          output.push(feature);
        }
      }
      return output;
    }

    async function refreshResults() {
      if (!layers.length) return;
      setMessage("Searching sites…");
      try {
        const radius = Number(elements.radius.value);
        const area = currentLocation && radius
          ? geometryEngine.geodesicBuffer(currentLocation, radius, "kilometers")
          : null;
        const queried = await Promise.all(layers.map((layer) => queryLayer(layer, area)));
        currentResults = queried.flat();
        currentResults.sort((a, b) => (featureDistance(a) ?? Infinity) - (featureDistance(b) ?? Infinity));
        renderResults();
        setMessage(currentResults.length ? `${currentResults.length} sites loaded` : "No sites found in this area.");
        showPanel("results");
      } catch (error) {
        console.error("Fuel site query failed", error);
        setMessage("Could not load sites for this search.");
        showError(`Could not query the fuel site layer: ${error.message || error}`);
      }
    }

    async function searchAddress(address, magicKey) {
      const text = address.trim();
      if (!text) return;
      closeSuggestions();
      setMessage("Finding address…");
      elements.error.hidden = true;
      try {
        try {
          const exactSite = await findExactSite(text);
          if (exactSite) {
            await searchSite(exactSite);
            return;
          }
        } catch (error) {
          console.error("Site name search failed", error);
        }
        const matches = await addressToLocations(GEOCODER_URL, {
          address: { SingleLine: text },
          magicKey,
          outFields: ["*"],
          maxLocations: 5,
          countryCode: "AUS"
        });
        if (!matches.length) {
          setMessage("No matching address found.");
          return;
        }
        currentLocation = matches[0].location;
        await view.goTo({ target: currentLocation, zoom: elements.radius.value ? 9 : 12 });
        view.graphics.removeAll();
        view.graphics.add(new Graphic({
          geometry: currentLocation,
          symbol: { type: "simple-marker", style: "circle", color: "#ffcf21", size: 17, outline: { color: "#fff", width: 2 } }
        }));
        await refreshResults();
      } catch (error) {
        console.error("Address geocoding failed", error);
        setMessage("Could not find that address.");
        showError(`Address search failed: ${error.message || error}`);
      }
    }

    function exportPdf() {
      const PDF = window.jspdf?.jsPDF;
      if (!PDF) {
        showError("PDF export could not load. Check your connection and try again.");
        return;
      }
      try {
        const sorted = applyFilters(currentResults)
          .sort((a, b) => (featureDistance(a) ?? Infinity) - (featureDistance(b) ?? Infinity));
        const doc = new PDF({ unit: "mm", format: "a4" });
        const pageHeight = doc.internal.pageSize.getHeight();
        let y = 18;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(17);
        doc.text("Fuel locator - search results", 14, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        const searchLabel = elements.address.value.trim() || "All sites";
        doc.text(`Search: ${searchLabel}`, 14, y);
        y += 6;
        doc.text(`Radius: ${elements.radius.value ? `${elements.radius.value} km` : "None"}   |   ${sorted.length} sites`, 14, y);
        y += 8;
        if (!sorted.length) {
          doc.text("No sites match the current search and filters.", 14, y);
        }
        for (const feature of sorted) {
          const lines = [
            siteName(feature),
            siteAddress(feature),
            `Distance: ${formatDistance(featureDistance(feature)) || "N/A"}`
          ].filter(Boolean);
          const blockHeight = 5 * lines.length + 7;
          if (y + blockHeight > pageHeight - 14) {
            doc.addPage();
            y = 18;
          }
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.text(doc.splitTextToSize(lines[0], 180), 14, y);
          y += 5;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          for (const line of lines.slice(1)) {
            const wrapped = doc.splitTextToSize(line, 180);
            doc.text(wrapped, 14, y);
            y += 4 * wrapped.length;
          }
          doc.setDrawColor(205);
          doc.line(14, y + 1, 196, y + 1);
          y += 7;
        }
        doc.save("fuel-locator-results.pdf");
      } catch (error) {
        console.error("PDF export failed", error);
        showError(`Could not export the current results as a PDF: ${error.message || error}`);
      }
    }

    (async () => {
      try {
        setMessage("Loading map…");
        await view.when();
        setMessage("Reading site fields…");
        const candidates = webmap.allLayers.filter((layer) => layer.type === "feature");
        await Promise.all(candidates.map((layer) => layer.load()));
        layers = candidates.filter((layer) => {
          if (layer.geometryType !== "point" && layer.geometryType !== "multipoint") return false;
          const nameField = findField(layer, [/\b(site|station|business|trading)\s*name\b/i, /\bname\b|displayname/i, /facility\s*name/i]);
          const addressField = findField(layer, [/\baddress\b/i, /street/i]);
          const hasFuelOrServiceFields = layer.fields.some((field) =>
            fuelTerms.test(fieldText(field)) ||
            serviceTerms.test(fieldText(field))
          );
          return Boolean(nameField && addressField && hasFuelOrServiceFields);
        });
        for (const layer of layers) {
          layer.fields.forEach((field) => fieldLayers.set(field, layer.id));
        }
        if (!layers.length) {
          throw new Error("The web map does not contain a point feature layer.");
        }
        classifyFields();
        setMessage(`${filterFields.products.length} product fields and ${filterFields.services.length} service fields loaded`);
        if (elements.address.value.trim().length >= 2) updateSuggestions(elements.address.value);
      } catch (error) {
        console.error("Web map initialization failed", error);
        showError(`Could not load the fuel locator web map. ${error.message || error}`);
        setMessage("Web map unavailable.");
      }
    })();

    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!elements.suggestions.hidden && activeSuggestion >= 0) {
        selectSuggestion(activeSuggestion);
      } else {
        closeSuggestions();
        searchAddress(elements.address.value);
      }
    });
    elements.address.addEventListener("input", () => {
      window.clearTimeout(suggestionTimer);
      suggestionTimer = window.setTimeout(() => updateSuggestions(elements.address.value), 250);
    });
    elements.address.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && !elements.suggestions.hidden) {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion + 1);
      } else if (event.key === "ArrowUp" && !elements.suggestions.hidden) {
        event.preventDefault();
        setActiveSuggestion(activeSuggestion < 0 ? searchSuggestions.length - 1 : activeSuggestion - 1);
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
    });
    elements.address.addEventListener("blur", () => window.setTimeout(closeSuggestions, 120));
    elements.clear.addEventListener("click", () => {
      elements.address.value = "";
      closeSuggestions();
      elements.address.focus();
    });
    elements.reset.addEventListener("click", () => {
      elements.address.value = "";
      closeSuggestions();
      elements.radius.value = "";
      currentLocation = null;
      currentResults = [];
      view.graphics.removeAll();
      renderResults();
      setMessage("");
      showPanel("filters");
    });
    elements.radius.addEventListener("change", () => {
      if (currentLocation) refreshResults();
    });
    document.getElementById("back-button").addEventListener("click", () => showPanel("results"));
    document.getElementById("show-map-button").addEventListener("click", () => {
      if (window.matchMedia("(max-width: 720px)").matches) elements.sidebar.classList.add("map-active");
      else showPanel("filters");
    });
    document.getElementById("mobile-map-button").addEventListener("click", () => {
      const isHidden = elements.sidebar.classList.toggle("map-active");
      document.getElementById("mobile-map-button").textContent = isHidden ? "Search" : "Map";
    });
    elements.export.addEventListener("click", exportPdf);
    for (const tab of document.querySelectorAll(".view-tab")) {
      tab.addEventListener("click", () => showPanel(tab.dataset.view));
    }
    for (const tab of document.querySelectorAll(".category-tab")) {
      tab.addEventListener("click", () => {
        activeProductCategory = tab.dataset.category;
        for (const categoryTab of document.querySelectorAll(".category-tab")) {
          categoryTab.classList.toggle("active", categoryTab === tab);
        }
        updateCategoryVisibility();
        updateResults();
      });
    }
    document.getElementById("products-match-all").addEventListener("change", updateResults);
    document.getElementById("services-match-all").addEventListener("change", updateResults);
    view.on("layerview-create-error", (event) => {
      console.error("Map layer view failed", event.error);
      showError(`A map layer could not be displayed: ${event.error.message || event.error}`);
    });
})();
