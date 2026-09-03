const server = require('express')();
const client = require('prom-client');
const { WebSocketClient } = require('./websocket');

const ENDPOINTS = (process.env.ENDPOINTS || process.env.ENDPOINT || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const gauges = new Map();

const GENERIC_LABELS = [
  'dtu',
  'source',
  'instance_id',
  'unit'
];

function sanitizeMetricName(name) {
  return name
    .replace(/[^a-zA-Z0-9_:]/g, '_')
    .replace(/^[^a-zA-Z_:]/, '_')
    .toLowerCase();
}

function getGauge(name) {
  name = sanitizeMetricName(name);

  if (!gauges.has(name)) {
    gauges.set(
      name,
      new client.Gauge({
        name,
        help: `WebSocket metric ${name}`,
        labelNames: GENERIC_LABELS
      })
    );
  }

  return gauges.get(name);
}

function setMetric(name, labels, value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return;
  }

  const finalLabels = {
    dtu: labels.dtu || '',
    source: labels.source || '',
    instance_id: labels.instance_id || '',
    unit: labels.unit || ''
  };

  getGauge(name)
    .labels(
      finalLabels.dtu,
      finalLabels.source,
      finalLabels.instance_id,
      finalLabels.unit
    )
    .set(numericValue);
}

function getEndpointInfo(endpoint) {
  try {
    const url = new URL(endpoint);

    return {
      dtu: url.hostname,
      source: url.pathname
        .replace(/^\/+/, '')
        .replace(/\/+/g, '_') || 'unknown'
    };
  } catch {
    return {
      dtu: 'unknown',
      source: 'unknown'
    };
  }
}

function normalizeBooleanString(value) {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'true' ||
    normalized === 'enabled'
  ) {
    return 1;
  }

  if (
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === 'false' ||
    normalized === 'disabled'
  ) {
    return 0;
  }

  return null;
}

/**
 * Export arbitrary JSON recursively.
 *
 * OpenDTU values:
 *
 *   { v: 50.53, u: "V", d: 2 }
 *
 * become a numeric metric with a unit label.
 *
 * Dynamic instances:
 *
 *   instances/HQ2342C94PU/...
 *
 * become:
 *
 *   instance_id="HQ2342C94PU"
 */
function exportJson(
  value,
  path = [],
  labels = {}
) {
  if (value === null || value === undefined) {
    return;
  }

  // ----------------------------------------------------------
  // OpenDTU value object:
  // { v: 50.53, u: "V", d: 2 }
  // ----------------------------------------------------------

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  ) {
    const metricLabels = {
      ...labels,
      unit:
        value.u !== undefined
          ? String(value.u)
          : ''
    };

    setMetric(
      'websocket_' + path.join('_'),
      metricLabels,
      value.v
    );

    return;
  }

  // ----------------------------------------------------------
  // OpenDTU text / boolean wrapper:
  //
  // { value: "yes", translate: true }
  // ----------------------------------------------------------

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    const wrappedValue = value.value;

    if (typeof wrappedValue === 'number') {
      setMetric(
        'websocket_' + path.join('_'),
        labels,
        wrappedValue
      );

      return;
    }

    if (typeof wrappedValue === 'boolean') {
      setMetric(
        'websocket_' + path.join('_'),
        labels,
        wrappedValue ? 1 : 0
      );

      return;
    }

    if (typeof wrappedValue === 'string') {
      const booleanValue =
        normalizeBooleanString(wrappedValue);

      if (booleanValue !== null) {
        setMetric(
          'websocket_' + path.join('_'),
          labels,
          booleanValue
        );
      }
    }

    return;
  }

  // ----------------------------------------------------------
  // Plain number
  // ----------------------------------------------------------

  if (typeof value === 'number') {
    setMetric(
      'websocket_' + path.join('_'),
      labels,
      value
    );

    return;
  }

  // ----------------------------------------------------------
  // Boolean -> 1 / 0
  // ----------------------------------------------------------

  if (typeof value === 'boolean') {
    setMetric(
      'websocket_' + path.join('_'),
      labels,
      value ? 1 : 0
    );

    return;
  }

  // ----------------------------------------------------------
  // Plain strings
  //
  // Deliberately ignored for now.
  // This avoids uncontrolled Prometheus label cardinality.
  // ----------------------------------------------------------

  if (typeof value === 'string') {
    return;
  }

  // ----------------------------------------------------------
  // Arrays
  // ----------------------------------------------------------

  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      exportJson(
        child,
        [...path, index.toString()],
        labels
      );
    });

    return;
  }

  // ----------------------------------------------------------
  // Objects
  // ----------------------------------------------------------

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {

      if (
        key === 'instances' &&
        child &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        for (
          const [instanceId, instanceData]
          of Object.entries(child)
        ) {
          exportJson(
            instanceData,
            path,
            {
              ...labels,
              instance_id: instanceId
            }
          );
        }

        continue;
      }

      exportJson(
        child,
        [...path, key],
        labels
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
  labelNames: ['dtu', 'source']
});

const websocketMessages = new client.Counter({
  name: 'websocket_messages_total',
  help: 'Number of WebSocket messages received',
  labelNames: ['dtu', 'source']
});


// ------------------------------------------------------------
// Open WebSockets
// ------------------------------------------------------------

ENDPOINTS.forEach(endpoint => {

  const endpointInfo =
    getEndpointInfo(endpoint);

  console.log(`Opening WebSocket: ${endpoint}`);
  console.log(
    `DTU: ${endpointInfo.dtu}, source: ${endpointInfo.source}`
  );

  const ws = new WebSocketClient();

  ws.onopen = function () {
    console.log(`Connected: ${endpoint}`);

    websocketUp
      .labels(
        endpointInfo.dtu,
        endpointInfo.source
      )
      .set(1);
  };

  ws.onerror = function (e) {
    console.error(`WebSocket error: ${endpoint}`, e);

    websocketUp
      .labels(
        endpointInfo.dtu,
        endpointInfo.source
      )
      .set(0);
  };

  ws.onclose = function () {
    console.log(`WebSocket closed: ${endpoint}`);

    websocketUp
      .labels(
        endpointInfo.dtu,
        endpointInfo.source
      )
      .set(0);
  };

  ws.onmessage = function (data) {
    try {
      websocketMessages
        .labels(
          endpointInfo.dtu,
          endpointInfo.source
        )
        .inc();

      const json =
        JSON.parse(data.toString());

      exportJson(
        json,
        [],
        {
          dtu: endpointInfo.dtu,
          source: endpointInfo.source,
          instance_id: '',
          unit: ''
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
  res
    .type('text/plain')
    .send(
      `WebSocket Exporter running\n` +
      `Configured endpoints: ${ENDPOINTS.length}\n`
    );
});

const PORT =
  process.env.PORT || 9189;

server.listen(PORT, () => {
  console.log(
    `Exporter listening on port ${PORT}`
  );
});
