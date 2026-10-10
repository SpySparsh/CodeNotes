import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Observability Configuration & Dashboard Validation', () => {
  const rootDir = path.resolve(__dirname, '..');

  const APPROVED_APPLICATION_METRICS = new Set([
    'http_requests_total',
    'http_request_duration_seconds',
    'codenotes_generation_jobs_total',
    'codenotes_generation_stage_duration_seconds',
    'codenotes_generation_duration_seconds',
    'codenotes_reconciliation_runs_total',
    'codenotes_stale_jobs_recovered_total',
    'codenotes_rate_limit_rejections_total',
    'codenotes_transcript_requests_total',
    'codenotes_transcript_duration_seconds',
    'codenotes_ai_requests_total',
    'codenotes_ai_duration_seconds',
  ]);

  const ALLOWED_PROMETHEUS_BUILTINS = new Set([
    'up',
    'ALERTS',
    'ALERTS_FOR_STATE',
  ]);

  const PROMQL_KEYWORDS = new Set([
    'sum', 'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv', 'histogram_quantile',
    'count', 'avg', 'min', 'max', 'stddev', 'stdvar', 'quantile', 'topk', 'bottomk',
    'by', 'without', 'and', 'or', 'unless', 'on', 'ignoring', 'group_left', 'group_right',
    'vector', 'scalar', 'offset', 'bool', 'le', 'status', 'method', 'route', 'stage',
    'source', 'model', 'endpoint', 'job', 'provider', 'instance', 'severity',
    'Inf', 'NaN', 'codenotes', 'supadata', 'completed', 'failed', 'started', 'replayed',
    'success', 'error', 'malformed_output', 'cache_hit', 'youtube_transcript_fallback',
    'claim', 'transcript_fetch', 'gemini_inference', 'db_persist', 'POST', 'GET',
  ]);

  function isMetricAllowed(metricName: string): boolean {
    if (APPROVED_APPLICATION_METRICS.has(metricName) || ALLOWED_PROMETHEUS_BUILTINS.has(metricName)) {
      return true;
    }
    for (const appMetric of APPROVED_APPLICATION_METRICS) {
      if (
        metricName === `${appMetric}_bucket` ||
        metricName === `${appMetric}_count` ||
        metricName === `${appMetric}_sum`
      ) {
        return true;
      }
    }
    return false;
  }

  function extractMetricNames(promql: string): string[] {
    const identifierRegex = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = identifierRegex.exec(promql)) !== null) {
      const id = match[1];
      if (!PROMQL_KEYWORDS.has(id) && !/^\d+$/.test(id)) {
        matches.push(id);
      }
    }
    return matches;
  }

  describe('Grafana Dashboard (grafana/dashboards/codenotes.json)', () => {
    const dashboardPath = path.join(rootDir, 'grafana', 'dashboards', 'codenotes.json');

    it('exists and parses as valid JSON', () => {
      expect(fs.existsSync(dashboardPath)).toBe(true);
      const content = fs.readFileSync(dashboardPath, 'utf8');
      const json = JSON.parse(content);
      expect(json).toBeDefined();
      expect(json.title).toBe('CodeNotes Overview');
      expect(Array.isArray(json.panels)).toBe(true);
      expect(json.panels.length).toBeGreaterThan(0);
    });

    it('validates panel queries and ensures every referenced metric is valid and approved', () => {
      const content = fs.readFileSync(dashboardPath, 'utf8');
      const json = JSON.parse(content);

      const panelExpressions: { panelId: number; title: string; expr: string }[] = [];

      function collectPanels(panels: any[]) {
        for (const panel of panels) {
          if (panel.targets && Array.isArray(panel.targets)) {
            for (const target of panel.targets) {
              if (target.expr) {
                panelExpressions.push({
                  panelId: panel.id,
                  title: panel.title || 'Untitled',
                  expr: target.expr,
                });
              }
            }
          }
          if (panel.panels && Array.isArray(panel.panels)) {
            collectPanels(panel.panels);
          }
        }
      }

      collectPanels(json.panels);
      expect(panelExpressions.length).toBeGreaterThanOrEqual(10);

      for (const { panelId, title, expr } of panelExpressions) {
        const metrics = extractMetricNames(expr);
        expect(
          metrics.length,
          `Panel ID ${panelId} ("${title}") has empty metric extraction for expr: ${expr}`
        ).toBeGreaterThan(0);

        for (const metric of metrics) {
          expect(
            isMetricAllowed(metric),
            `Panel ID ${panelId} ("${title}") references unapproved or nonexistent metric: "${metric}" in expression: "${expr}"`
          ).toBe(true);
        }
      }
    });

    it('ensures datasource references point to Prometheus type', () => {
      const content = fs.readFileSync(dashboardPath, 'utf8');
      const json = JSON.parse(content);

      for (const panel of json.panels) {
        if (panel.type !== 'row' && panel.datasource) {
          expect(panel.datasource.type).toBe('prometheus');
        }
        if (panel.targets) {
          for (const target of panel.targets) {
            if (target.datasource) {
              expect(target.datasource.type).toBe('prometheus');
            }
          }
        }
      }
    });
  });

  describe('Prometheus Alert Rules (prometheus/rules/alerts.yml)', () => {
    const alertsPath = path.join(rootDir, 'prometheus', 'rules', 'alerts.yml');

    it('exists and contains valid alerting rules structure', () => {
      expect(fs.existsSync(alertsPath)).toBe(true);
      const content = fs.readFileSync(alertsPath, 'utf8');

      expect(content).toContain('groups:');
      expect(content).toContain('name: codenotes_alerts');
      expect(content).toContain('rules:');

      // Check required alert rules exist
      expect(content).toContain('alert: ServiceUnreachable');
      expect(content).toContain('alert: HighHttp5xxErrorRate');
      expect(content).toContain('alert: HighGenerationFailureRate');
      expect(content).toContain('alert: HighGeminiLatency');
      expect(content).toContain('alert: TranscriptProviderPrimaryFailure');
    });

    it('ensures all metrics referenced in alert rules are approved application metrics or up', () => {
      const content = fs.readFileSync(alertsPath, 'utf8');
      const ruleBlocks = content.split(/- alert:\s*/).slice(1);
      expect(ruleBlocks.length).toBe(5);

      for (const block of ruleBlocks) {
        const alertName = block.split('\n')[0].trim();
        const exprMatch = block.match(/expr:\s*(?:>-)?\s*\n?([\s\S]*?)(?=\n\s+for:)/);
        expect(exprMatch, `Could not find expr in alert ${alertName}`).toBeDefined();

        const expr = exprMatch![1].replace(/\s+/g, ' ').trim();
        const metrics = extractMetricNames(expr);
        expect(metrics.length, `No metrics found in alert ${alertName} expr: ${expr}`).toBeGreaterThan(0);

        for (const metric of metrics) {
          expect(
            isMetricAllowed(metric),
            `Alert ${alertName} references unapproved metric: "${metric}" in "${expr}"`
          ).toBe(true);
        }
      }
    });
  });

  describe('Prometheus Scrape Configuration (prometheus/prometheus.yml)', () => {
    const prometheusConfigPath = path.join(rootDir, 'prometheus', 'prometheus.yml');

    it('exists and targets the /api/metrics endpoint under codenotes job', () => {
      expect(fs.existsSync(prometheusConfigPath)).toBe(true);
      const content = fs.readFileSync(prometheusConfigPath, 'utf8');

      expect(content).toContain('job_name: "codenotes"');
      expect(content).toContain('metrics_path: "/api/metrics"');
      expect(content).toContain('rule_files:');
      expect(content).toContain('/etc/prometheus/rules/*.yml');
    });
  });

  describe('Docker Compose & Provisioning Mount Validation (docker-compose.prometheus.yml)', () => {
    const dockerComposePath = path.join(rootDir, 'docker-compose.prometheus.yml');

    it('exists and all local volume mount paths resolve to real files/directories', () => {
      expect(fs.existsSync(dockerComposePath)).toBe(true);
      const content = fs.readFileSync(dockerComposePath, 'utf8');

      // Check prometheus mount sources
      const prometheusYml = path.join(rootDir, 'prometheus', 'prometheus.yml');
      const prometheusRules = path.join(rootDir, 'prometheus', 'rules');
      expect(fs.existsSync(prometheusYml)).toBe(true);
      expect(fs.existsSync(prometheusRules)).toBe(true);

      // Check grafana provisioning mount sources
      const datasourcesYml = path.join(rootDir, 'grafana', 'provisioning', 'datasources', 'datasources.yml');
      const dashboardsYml = path.join(rootDir, 'grafana', 'provisioning', 'dashboards', 'dashboards.yml');
      const dashboardsDir = path.join(rootDir, 'grafana', 'dashboards');

      expect(fs.existsSync(datasourcesYml)).toBe(true);
      expect(fs.existsSync(dashboardsYml)).toBe(true);
      expect(fs.existsSync(dashboardsDir)).toBe(true);

      // Verify datasources.yml points to prometheus:9090
      const dsContent = fs.readFileSync(datasourcesYml, 'utf8');
      expect(dsContent).toContain('url: http://prometheus:9090');
      expect(dsContent).toContain('type: prometheus');

      // Verify dashboards.yml points to /var/lib/grafana/dashboards
      const dbContent = fs.readFileSync(dashboardsYml, 'utf8');
      expect(dbContent).toContain('path: /var/lib/grafana/dashboards');
    });
  });
});
