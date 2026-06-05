// Vendored from Understand-Anything (@understand-anything/core, MIT License)
// https://github.com/Lum1104/Understand-Anything
// 该文件为上游纯算法/数据模型,近原样移植(R11 A 类 vendor)。请勿在此手改算法;
// 如需适配 Kocode,请在 Kocode 侧的适配器层处理。

import type { LanguageConfig } from "../types";

// TODO: Kubernetes manifests are YAML files with no unique extension or filename.
// Detection requires content-based or path-pattern heuristics (e.g., checking for
// `apiVersion`/`kind` fields in YAML, or matching paths like `k8s/`, `kubernetes/`,
// `deploy/`). Currently these files will match `yamlConfig` by extension (.yaml/.yml).
// A future content-based detection pass could re-classify them as Kubernetes.
export const kubernetesConfig = {
  id: "kubernetes",
  displayName: "Kubernetes",
  extensions: [],
  concepts: ["deployments", "services", "pods", "configmaps", "secrets", "ingress", "volumes", "namespaces"],
  filePatterns: {
    entryPoints: [],
    barrels: [],
    tests: [],
    config: ["k8s/*.yaml", "kubernetes/*.yaml"],
  },
} satisfies LanguageConfig;
