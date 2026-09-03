const server = require('express')();
const client = require('prom-client');
const { WebSocketClient } = require('./websocket');

const ENDPOINTS = (process.env.ENDPOINTS || process.env.ENDPOINT || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const gauges = new Map();

function sanitizeMetricName(name) {
  let result = name
    .replace(/[^a-zA-Z0-9_:]/g, '_')
    .replace(/^[^a-zA-Z_:]/, '_');

  return result.toLowerCase();
}

function sanitizeLabelName(name) {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[^a-zA-Z_]/, '_')
    .toLowerCase();
}

function metricKey(name, labelNames) {
  return `${name}|${labelNames.join(',')}`;
}

function getGauge(name, labelNames) {
  name = sanitizeMetricName(name);

  const cleanLabelNames = labelNames.map(sanitizeLabelName);
  const key = metricKey(name, cleanLabelNames);

  if (!gauges.has(key)) {
    gauges.set(
      key,
      new client.Gauge({
        name,
        help: `WebSocket metric ${name}`,
        labelNames: cleanLabelNames
      })
    );
  }

  return gauges.get(key);
}

function setMetric(name, labels, value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return;
  }

  const labelNames = Object.keys(labels);
  const labelValues = Object.values(labels).map(v => String(v));

  const gauge = getGauge(name, labelNames);

  gauge.labels(...labelValues).set(numericValue);
}

function getEndpointName(endpoint) {
  try {
    const url = new URL(endpoint);

    return `${url.hostname}${url.pathname}`
      .replace(/^\/+/, '')
      .replace(/\//g, '_');
  } catch {
    return endpoint;
  }
}

/**
 * Export arbitrary JSON recursively.
 *
 * Special handling:
 *
 *   { v: 50.53, u: "V", d: 2 }
 *
 * becomes one numeric metric with unit label.
 *
 * Dynamic path:
 *
 *   instances/HQ2342C94PU/...
 *
 * becomes:
 *
 *   instance_id="HQ2342C94PU"
 *
 * instead of putting the serial into the metric name.
 */
function exportJson(
  value,
  path = [],
  labels = {},
  context = {}
) {
  if (value === null || value === undefined) {
    return;
  }

  // ----------------------------------------------------------
  // OpenDTU style value object:
  //
  // { v: 50.53, u: "V", d: 2 }
  // ----------------------------------------------------------

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  ) {
    const metricLabels = { ...labels };

    if (value.u !== undefined && value.u !== '') {
      metricLabels.unit = String(value.u);
    }

    const metricName =
      'websocket_' + path.join('_');

    setMetric(
      metricName,
      metricLabels,
      value.v
    );

    return;
  }

  // ----------------------------------------------------------
  // Plain number
  // ----------------------------------------------------------

  if (typeof value === 'number') {
    const metricName =
      'websocket_' + path.join('_');

    setMetric(
      metricName,
      labels,
      value
    );

    return;
  }

  // ----------------------------------------------------------
  // Boolean -> 1 / 0
  // ----------------------------------------------------------

  if (typeof value === 'boolean') {
    const metricName =
      'websocket_' + path.join('_');

    setMetric(
      metricName,
      labels,
      value ? 1 : 0
    );

    return;
  }

  // ----------------------------------------------------------
  // Arrays
  // ----------------------------------------------------------

  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      exportJson(
        child,
        path,
        {
          ...labels,
          index
        },
        context
      );
    });

    return;
  }

  // ----------------------------------------------------------
  // Objects
  // ----------------------------------------------------------

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {

      /*
       * Special rule:
       *
       * "instances": {
       *   "HQ2342C94PU": {...}
       * }
       *
       * The child key should become a label instead of
       * part of the metric name.
       */

      if (
        key === 'instances' &&
        child &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        for (const [instanceId, instanceData] of Object.entries(child)) {
          exportJson(
            instanceData,
            path,
            {
              ...labels,
              instance_id: instanceId
            },
            {
              ...context,
              insideInstances: true
            }
          );
        }

        continue;
      }

      exportJson(
        child,
        [...path, key],
        labels,
        context
      );
    }
  }
}


// ------------------------------------------------------------
// WebSocket status
// ------------------------------------------------------------

const websocketUp = new client.Gauge({
  name: 'websocket_up',
  help: 'WebSocket connection status',
  labelNames: ['endpoint']
});

const websocketMessages = new client.Counter({
  name: 'websocket_messages_total',
  help: 'Number of WebSocket messages received',
  labelNames: ['endpoint']
});


// ------------------------------------------------------------
// Open WebSockets
// ------------------------------------------------------------

ENDPOINTS.forEach(endpoint => {

  const endpointName = getEndpointName(endpoint);

  console.log(`Opening WebSocket: ${endpoint}`);

  const ws = new WebSocketClient();

  ws.onopen = function () {
    console.log(`Connected: ${endpoint}`);

    websocketUp
      .labels(endpointName)
      .set(1);
  };

  ws.onerror = function (e) {
    console.error(`WebSocket error: ${endpoint}`, e);

    websocketUp
      .labels(endpointName)
      .set(0);
  };

  ws.onclose = function () {
    console.log(`WebSocket closed: ${endpoint}`);

    websocketUp
      .labels(endpointName)
      .set(0);
  };

  ws.onmessage = function (data) {
    try {
      websocketMessages
        .labels(endpointName)
        .inc();

      const json = JSON.parse(data.toString());

      exportJson(
        json,
        [],
        {
          endpoint: endpointName
        }
      );

    } catch (e) {
      console.error(
        `Could not parse JSON from ${endpoint}:`,
        e.message
      );
    }
  };

  ws.open(endpoint);
});


// ------------------------------------------------------------
// Prometheus endpoint
// ------------------------------------------------------------

server.get('/metrics', async (req, res) => {
  try {
    res.set(
      'Content-Type',
      client.register.contentType
    );

    res.end(
      await client.register.metrics()
    );
  } catch (e) {
    res.status(500).end(e.message);
  }
});

server.get('/', (req, res) => {
  res.type('text/plain').send(
    `WebSocket Exporter running\nConfigured endpoints: ${ENDPOINTS.length}\n`
  );
});

const PORT = process.env.PORT || 9189;

server.listen(PORT, () => {
  console.log(`Exporter listening on port ${PORT}`);
});
