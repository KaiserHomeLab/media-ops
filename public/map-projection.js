// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KaiserHomeLab
//
// Natural Earth map projection (Šavrič et al., 2011), shared by the browser (stream map
// dots) and scripts/build-world-map.js (coastlines), so both always line up.
// Same polynomial as d3-geo's geoNaturalEarth1.
(function (root) {
  'use strict';
  const SCALE = 150;
  const LAT_TOP = 84,
    LAT_BOTTOM = -57; // crop the polar regions nobody streams from

  function raw(lon, lat) {
    const l = (lon * Math.PI) / 180,
      p = (lat * Math.PI) / 180;
    const p2 = p * p,
      p4 = p2 * p2;
    return [
      l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
      p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
    ];
  }

  const [xMax] = raw(180, 0);
  const yTop = raw(0, LAT_TOP)[1],
    yBottom = raw(0, LAT_BOTTOM)[1];
  const WIDTH = Math.round(2 * xMax * SCALE);
  const HEIGHT = Math.round((yTop - yBottom) * SCALE);

  // [lon, lat] in degrees -> [x, y] in SVG units (0..WIDTH, 0..HEIGHT; y grows downward).
  function project(lon, lat) {
    const [x, y] = raw(lon, Math.max(LAT_BOTTOM - 5, Math.min(LAT_TOP + 5, lat)));
    return [(x + xMax) * SCALE, (yTop - y) * SCALE];
  }

  const api = { project, WIDTH, HEIGHT, LAT_TOP, LAT_BOTTOM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapProjection = api;
})(this);
