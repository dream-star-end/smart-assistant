/**
 * researchConfig 纯逻辑单测(不碰 PG):
 *   - validateResearchConfig 严格 schema:接受合法、拒未知字段 / enum 越界。
 *   - DEFAULT_RESEARCH_CONFIG 自身合法(缺省全走免费 API + 进程内 fallback)。
 *   - secret 名白名单。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_RESEARCH_CONFIG,
  RESEARCH_SECRET_NAMES,
  ResearchConfigValidationError,
  validateResearchConfig,
} from "../admin/researchConfig.js";

describe("researchConfig.validateResearchConfig", () => {
  it("DEFAULT_RESEARCH_CONFIG 合法", () => {
    const out = validateResearchConfig(DEFAULT_RESEARCH_CONFIG);
    assert.equal(out.ingest.engine, "auto");
    assert.equal(out.litrag.embedBackend, "local");
    assert.equal(out.litrag.vectorBackend, "inproc");
    assert.equal(out.cite.retraction, "crossref");
  });

  it("接受完整合法配置(含可选 endpoint)", () => {
    const cfg = {
      litSources: { openalexMailto: "a@b.com", s2Enabled: true },
      ingest: { engine: "mineru", mineruEndpoint: "http://x", grobidEndpoint: "http://g" },
      litrag: { embedBackend: "http", embedEndpoint: "http://e", vectorBackend: "qdrant", qdrantUrl: "http://q" },
      cite: { retraction: "off", strictDomains: ["clinical"] },
      minicheck: { backend: "http", endpoint: "http://mc", threshold: 0.6, strict: true },
      limits: { dailyCap: 1000, perContainerPerMin: 10 },
    };
    const out = validateResearchConfig(cfg);
    assert.equal(out.ingest.engine, "mineru");
    assert.equal(out.litrag.vectorBackend, "qdrant");
  });

  it("拒未知顶层字段(additionalProperties:false)", () => {
    const bad = { ...DEFAULT_RESEARCH_CONFIG, evil: 1 };
    assert.throws(() => validateResearchConfig(bad), ResearchConfigValidationError);
  });

  it("拒未知子字段", () => {
    const bad = {
      ...DEFAULT_RESEARCH_CONFIG,
      ingest: { engine: "auto", bogus: true },
    };
    assert.throws(() => validateResearchConfig(bad), ResearchConfigValidationError);
  });

  it("拒 ingest.engine 枚举越界", () => {
    const bad = { ...DEFAULT_RESEARCH_CONFIG, ingest: { engine: "gpu-magic" } };
    assert.throws(() => validateResearchConfig(bad), ResearchConfigValidationError);
  });

  it("拒 litrag.vectorBackend 枚举越界", () => {
    const bad = {
      ...DEFAULT_RESEARCH_CONFIG,
      litrag: { embedBackend: "local", vectorBackend: "pinecone" },
    };
    assert.throws(() => validateResearchConfig(bad), ResearchConfigValidationError);
  });

  it("拒缺必填子对象", () => {
    const bad = { litSources: {}, ingest: { engine: "auto" } };
    assert.throws(() => validateResearchConfig(bad), ResearchConfigValidationError);
  });

  it("secret 名白名单稳定", () => {
    assert.deepEqual(
      [...RESEARCH_SECRET_NAMES].sort(),
      ["embedApiKey", "mineruApiKey", "mistralApiKey", "qdrantApiKey", "s2ApiKey"],
    );
  });
});
