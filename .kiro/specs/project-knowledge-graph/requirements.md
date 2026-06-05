# Requirements Document

## Introduction

本功能将开源项目 Understand-Anything（MIT 许可）的代码理解能力以原生方式构建进 Kocode VS Code 扩展，命名为「项目知识图谱（Project Knowledge Graph）」。

核心目标是：为目标工作区生成一份结构化的项目知识图谱，并在 Worker agent 启动时把与当前任务相关的图谱片段作为上下文注入到 `ContextSanitizer.toWorkerPrompt()` 拼出的 prompt 中，从而减少 Worker（贵模型 deepseek-v4-pro）自行探索代码的次数，降低错误率与 token 消耗。可视化不是本期重点。

为控制成本，图谱生成分为三个可独立开关的层级（Tier 0 结构层 / Tier 1 语义层 / Tier 2 深度层）：schema 始终保留完整形状（廉价），但生成过程按需分层（生成才贵）。结构事实由 tree-sitter（wasm）权威提取且免费；语义摘要复用现有便宜模型 `FlashModelClient`（deepseek-v4-flash）；深度层默认不自动全量生成。

数据落盘在工作区 `.understand-anything/` 目录，保留与上游兼容的 `knowledge-graph.json` 形状，便于迁移与未来可视化。

freshness / stale 降级是本功能的核心风险点：注入错误文件或过时（stale）的语义内容会误导 Worker，比不注入更糟。因此图谱缺失或过时时，聊天与任务不阻塞，降级为只提供目录骨架并提示可生成/刷新，不注入可能过时的语义内容。

## Glossary

- **Kocode**：本 VS Code 扩展产品。
- **Flash_Agent**：基于便宜模型 deepseek-v4-flash 的对话/意图分类 agent，负责把对话提炼成 TaskSpec，读不了文件、不写代码。对应 `FlashModelClient` / `FlashAgentSession`。
- **Worker_Agent**：基于贵模型 deepseek-v4-pro 的执行 agent（Cline），对应 `ClineWorkerAdapter`。其全部初始上下文来自 `ContextSanitizer.toWorkerPrompt(taskSpec)`。
- **Orchestrator**：编排器，对应 `KocodeOrchestrator`。
- **Context_Sanitizer**：拼装 Worker 初始 prompt 的组件，对应 `ContextSanitizer`，其 `toWorkerPrompt()` 是图谱上下文唯一明确的注入点。
- **TaskSpec**：Flash_Agent 从对话提炼出的任务规格，包含 goal/mode/files/constraints/acceptanceCriteria 等字段，定义于 `src/shared/kocode.ts`。
- **Flash_Model_Client**：便宜模型客户端，对应 `FlashModelClient`（deepseek-v4-flash）。语义摘要复用此客户端，仅替换 system prompt，不引入新模型配置。
- **Tree_Sitter_Service**：Kocode 现有的 web-tree-sitter（wasm）解析服务，位于 `src/services/tree-sitter/`。VS Code 扩展环境只能用 wasm，不能用原生 node 绑定（硬约束）。
- **Knowledge_Graph**：项目知识图谱整体数据结构，包含 nodes（节点）、edges（边）、layers（架构层）、tours（导览）、domains（业务域）。
- **Graph_Node**：图谱节点，代表文件、符号、模块等实体。
- **Graph_Edge**：图谱边，代表节点间关系（如 import、定义归属等）。
- **Tier_0**：结构层。永远开、免费，由 Tree_Sitter_Service 权威提取文件/符号/import 边。
- **Tier_1**：语义层。由 Flash_Model_Client 生成文件/模块一句话用途与架构层归类，标记为「参考」。
- **Tier_2**：深度层。按需/后台生成 guided tour、domain 业务流、diff impact，默认不自动全量生成。
- **Graph_Store**：图谱落盘目录 `.understand-anything/`，含 `knowledge-graph.json` 与 `meta.json`。
- **Meta_File**：`.understand-anything/meta.json`，记录生成时的 `gitCommitHash`、各文件 fingerprint、生成层级与状态等元数据。
- **Fingerprint**：文件指纹，用于区分 cosmetic（仅格式/注释等表层变化）与 structural（结构变化）。
- **Change_Class**：变更分类结果，取值 NONE / COSMETIC / STRUCTURAL / ADDED / DELETED。
- **Graph_Retriever**：检索器，按 TaskSpec 从 Knowledge_Graph 检索相关节点/边/层。
- **Authoritative_Fact**：权威事实，来自 Tier_0 的结构信息，注入时标记为「权威」。
- **Reference_Summary**：参考摘要，来自 Tier_1/Tier_2 的语义信息，注入时标记为「参考」。
- **Stale**：图谱内容与当前工作区 git 状态不一致的状态。
- **Skeleton_Context**：降级上下文，仅含目录骨架与「可生成/刷新」提示，不含语义内容。
- **Analyze_Command**：命令 `kocode.knowledge.analyze`，触发全量分析。
- **Refresh_Command**：命令 `kocode.knowledge.refresh`，触发增量更新。
- **Open_Project_Map_Command**：命令 `kocode.knowledge.openProjectMap`，本期占位/禁用。
- **Git_Hook**：监听 Kocode 执行的 git commit/merge/rebase/cherry-pick 的钩子层。
- **Auto_Update**：配置项，为 true 时在 git commit 后后台执行 fingerprint 增量更新。

## Requirements

### Requirement 1: Tier 0 结构层提取（权威、免费）

**User Story:** 作为 Kocode 用户，我希望系统用 tree-sitter 权威提取项目的文件、符号与 import 关系，以便 Worker_Agent 拿到可信的项目结构事实而无需自行扫描代码。

#### Acceptance Criteria

1. WHEN Analyze_Command 被触发，THE Tier_0 SHALL 使用 Tree_Sitter_Service（wasm）解析工作区受支持语言的源文件，提取文件节点、符号节点（函数/类/方法等定义名）与 import 边。
2. THE Tier_0 SHALL 将提取出的文件、符号与 import 关系写入 Knowledge_Graph 的 nodes 与 edges。
3. THE Tier_0 SHALL 将其产出的所有 Graph_Node 与 Graph_Edge 标记为 Authoritative_Fact。
4. WHERE 某文件的扩展名不属于 Tree_Sitter_Service 支持的语言，THE Tier_0 SHALL 仍为该文件创建文件节点但不提取符号节点。
5. IF Tree_Sitter_Service 解析单个文件失败，THEN THE Tier_0 SHALL 跳过该文件的符号提取、为该文件保留文件节点，并在生成日志中记录该文件路径与失败原因。
6. THE Tier_0 SHALL 应用工作区忽略规则（ignore-filter）排除被忽略的路径，不对其创建节点。
7. THE Tier_0 SHALL 在 Tier_1 与 Tier_2 关闭时仍可独立完整生成结构层。
8. THE Tier_0 SHALL 移除现有实现中 50 文件上限的限制，对工作区内全部受支持源文件执行结构提取。

### Requirement 2: Tier 1 语义层生成（参考、便宜模型）

**User Story:** 作为 Kocode 用户，我希望系统用便宜模型为文件/模块生成一句话用途并归类到架构层，以便 Worker_Agent 快速理解各部分职责。

#### Acceptance Criteria

1. WHERE Tier_1 处于开启状态，WHEN 结构层生成完成，THE Tier_1 SHALL 调用 Flash_Model_Client 为每个文件节点生成一句话用途摘要。
2. THE Tier_1 SHALL 将生成的语义摘要写入对应 Graph_Node，并标记为 Reference_Summary。
3. THE Tier_1 SHALL 将文件/模块归类到 Knowledge_Graph 的 layers（架构层）。
4. THE Tier_1 SHALL 复用现有 Flash_Model_Client（deepseek-v4-flash），仅通过替换 system prompt 实现语义生成，不引入新的模型配置项。
5. IF Flash_Model_Client 对某节点的语义生成失败，THEN THE Tier_1 SHALL 保留该节点的 Tier_0 结构信息、将该节点语义字段置空，并继续处理其余节点。
6. WHERE Tier_1 处于关闭状态，THE Tier_0 结构层 SHALL 不受影响地完成生成。

### Requirement 3: Tier 2 深度层（按需、默认不全量）

**User Story:** 作为 Kocode 用户，我希望深度分析（guided tour、业务域流程、diff impact）仅在我请求或后台按需触发，以便避免大仓库全量生成产生的高额便宜模型调用成本。

#### Acceptance Criteria

1. THE Tier_2 SHALL 默认不在 Analyze_Command 触发时对全仓库执行全量生成。
2. WHEN 用户显式请求深度分析或后台按需任务触发，THE Tier_2 SHALL 生成 guided tour、domain 业务流与 diff impact 内容并写入 Knowledge_Graph 的 tours 与 domains。
3. THE Tier_2 SHALL 将其产出标记为 Reference_Summary。
4. WHERE 工作区被判定为大仓库且 Tier_2 被请求全量生成，THE Tier_2 SHALL 在执行前提示用户预计的调用规模并要求确认后再继续。
5. WHERE Tier_2 处于关闭或未生成状态，THE Knowledge_Graph SHALL 仍为有效图谱且 tours 与 domains 字段允许为空集合。

### Requirement 4: 数据模型与落盘兼容

**User Story:** 作为 Kocode 维护者，我希望图谱以与上游兼容的 `knowledge-graph.json` 形状落盘，以便迁移已有图谱并为未来可视化预留结构。

#### Acceptance Criteria

1. THE Graph_Store SHALL 将 Knowledge_Graph 持久化到工作区 `.understand-anything/knowledge-graph.json`。
2. THE knowledge-graph.json SHALL 完整保留 nodes、edges、layers、tours、domains 五类字段的兼容形状，即使某些字段在本期为空集合。
3. THE Graph_Store SHALL 将生成元数据持久化到 `.understand-anything/meta.json`，至少包含 gitCommitHash、各文件 Fingerprint、已生成的层级与生成状态。
4. WHEN Knowledge_Graph 即将被处理（无论是否最终写盘），THE Graph_Store SHALL 校验并移除指向不存在节点的 dangling edge，并校验 layers 与 tours 中的节点引用有效。
5. IF Graph_Store 读取到的 knowledge-graph.json 无法解析为有效 Knowledge_Graph，THEN THE Graph_Store SHALL 视为图谱缺失并触发降级流程而非中断扩展运行。
6. THE Graph_Store SHALL 对一份有效 Knowledge_Graph 执行写盘后再读取所得对象与原对象在语义上等价（round-trip 一致性）。

### Requirement 5: 检索与 Worker 上下文注入（含上限与权威/参考标注）

**User Story:** 作为 Kocode 用户，我希望系统按当前任务自动检索相关图谱片段并注入 Worker 上下文，以便 Worker_Agent 少自行探索、直达相关文件与关系。

#### Acceptance Criteria

1. WHEN Worker_Agent 启动且存在有效且非 Stale 的 Knowledge_Graph，THE Graph_Retriever SHALL 依据 TaskSpec（goal/files/constraints/acceptanceCriteria）检索相关 Graph_Node 与 Graph_Edge。
2. THE Context_Sanitizer SHALL 将检索结果注入 `toWorkerPrompt()` 生成的 prompt 中。
3. THE Context_Sanitizer SHALL 将来自 Tier_0 的结构信息标注为「权威」，将来自 Tier_1/Tier_2 的语义信息标注为「参考」。
4. THE Graph_Retriever SHALL 将单次注入的相关节点数量限制为不超过 10 个、关系数量不超过 20 条、架构层数量不超过 3 个。
5. WHERE 检索结果超出注入上限，THE Context_Sanitizer SHALL 仅保留摘要、文件路径与关键关系，省略其余细节。
6. THE Graph_Retriever SHALL 按与 TaskSpec 的相关度对节点与关系排序，使最相关项在受限注入中优先保留。
7. IF Knowledge_Graph 缺失或被判定为 Stale，THEN THE Context_Sanitizer SHALL 不注入任何 Reference_Summary 语义内容。

### Requirement 6: Freshness 与 Stale 降级

**User Story:** 作为 Kocode 用户，我希望图谱过时或缺失时系统宁可不注入语义内容也不误导 Worker，以便避免比不注入更糟的错误引导。

#### Acceptance Criteria

1. WHEN Worker_Agent 启动，THE Orchestrator SHALL 通过比较 Meta_File 的 gitCommitHash 与当前 git HEAD 判定 Knowledge_Graph 是否 Stale。
2. IF Knowledge_Graph 缺失，THEN THE Context_Sanitizer SHALL 注入 Skeleton_Context（目录骨架 + 「可生成」提示）而不阻塞聊天或任务。
3. IF Knowledge_Graph 被判定为 Stale，THEN THE Context_Sanitizer SHALL 注入 Skeleton_Context（目录骨架 + 「可刷新」提示）且不注入 Reference_Summary 语义内容。
4. WHILE Knowledge_Graph 处于缺失或 Stale 状态，THE Orchestrator SHALL 允许聊天与任务正常进行，不因图谱状态而阻塞。
5. WHERE Tier_0 结构信息可用且未 Stale 但 Tier_1 语义内容 Stale，THE Context_Sanitizer SHALL 注入权威结构信息但省略对应的过时语义摘要。

### Requirement 7: git commit 后增量更新

**User Story:** 作为 Kocode 用户，我希望图谱在每次 commit 后按需增量更新且只对真正的结构变化调用便宜模型，以便保持图谱新鲜同时控制成本。

#### Acceptance Criteria

1. WHERE Auto_Update 为 true，WHEN Git_Hook 检测到 Kocode 执行的 git commit/merge/rebase/cherry-pick，THE Orchestrator SHALL 在后台启动 Fingerprint 增量更新。
2. THE 增量更新流程 SHALL 比较 Meta_File 的 gitCommitHash 与当前 HEAD，并对受影响文件计算 Change_Class。
3. IF 某文件的 Change_Class 为 COSMETIC，THEN THE 增量更新流程 SHALL 仅更新 Meta_File 而不触发任何 Flash_Model_Client 调用。
4. IF 某文件的 Change_Class 为 STRUCTURAL，THEN THE 增量更新流程 SHALL 对该文件对应的 Graph_Node 执行 partial update（替换该文件相关节点与边）。
5. WHEN 检测到新增文件（ADDED），THE 增量更新流程 SHALL 为该文件创建对应 Graph_Node 与 Graph_Edge。
6. WHEN 检测到删除文件（DELETED），THE 增量更新流程 SHALL 移除该文件对应的 Graph_Node 及其相关 Graph_Edge。
7. WHERE 增量变化规模超过预设阈值（大规模结构变化），THE Orchestrator SHALL 提示用户运行 full rebuild 而不静默执行可能不完整的增量更新。
8. WHEN 增量更新完成，THE Graph_Store SHALL 将新的 gitCommitHash 与 Fingerprint 写入 Meta_File。

### Requirement 8: 便宜模型语义摘要的进度、取消与成本

**User Story:** 作为 Kocode 用户，我希望后台语义生成任务可见进度、可取消并记录成本，以便我掌控便宜模型的开销。

#### Acceptance Criteria

1. WHILE Tier_1 或 Tier_2 后台任务运行中，THE Orchestrator SHALL 在 UI 显示当前进度。
2. WHEN 用户请求取消后台任务，THE Orchestrator SHALL 停止后续 Flash_Model_Client 调用并保留已生成的部分结果。
3. IF 取消请求到达时已有一次 Flash_Model_Client 调用正在进行，THEN THE Orchestrator SHALL 等待该调用完成后再停止，并保留包含该调用产出在内的全部结果。
4. WHILE 取消的清理操作进行中，THE Orchestrator SHALL 保持任务状态为 running，直至所有取消步骤完成后再切换为 cancelled。
5. WHEN 后台任务结束，THE Orchestrator SHALL 记录并展示本次任务的 token 用量与成本摘要。
6. THE 语义生成流程 SHALL 复用现有 Flash_Model_Client，不引入新的模型配置项。

### Requirement 9: 命令与 Git Hook

**User Story:** 作为 Kocode 用户，我希望通过明确的命令触发分析与刷新，并由 hook 在 git 操作后自动维护图谱，以便按需控制图谱生命周期。

#### Acceptance Criteria

1. THE Kocode SHALL 注册命令 Analyze_Command（`kocode.knowledge.analyze`）用于触发全量分析。
2. THE Kocode SHALL 注册命令 Refresh_Command（`kocode.knowledge.refresh`）用于触发增量更新。
3. THE Kocode SHALL 注册命令 Open_Project_Map_Command（`kocode.knowledge.openProjectMap`），且本期 SHALL 将其呈现为占位/禁用状态。
4. THE Git_Hook SHALL 监听 Kocode 执行的 git commit/merge/rebase/cherry-pick 事件。
5. WHERE Auto_Update 为 false，WHEN Git_Hook 检测到 git 事件，THE Orchestrator SHALL 不自动启动增量更新。

### Requirement 10: 错误处理与离线降级

**User Story:** 作为 Kocode 用户，我希望断网或模型失败时系统保留已有图谱并显示可恢复错误，以便我的工作流不被中断。

#### Acceptance Criteria

1. IF Flash_Model_Client 因断网或模型失败而不可用，THEN THE Orchestrator SHALL 保留已存在的 Knowledge_Graph 不被清空或损坏。
2. IF 语义生成因断网或模型失败而中断，THEN THE Orchestrator SHALL 在 UI 显示一个可恢复（可重试）的错误提示。
3. WHILE Flash_Model_Client 不可用，THE Tier_0 结构层分析 SHALL 仍可执行并产出权威结构图谱。
4. IF Graph_Store 写盘失败，THEN THE Orchestrator SHALL 保留上一份有效的 Knowledge_Graph 并在 UI 显示可恢复错误，不使图谱进入损坏状态。

### Requirement 11: 上游代码复用约束

**User Story:** 作为 Kocode 维护者，我希望尽量原样 vendor 上游纯算法模块、只替换 IO 与原生绑定相关层，以便减少重写并降低维护风险。

#### Acceptance Criteria

1. THE 实现 SHALL 将上游纯算法与数据模型模块（schema、types、fingerprint、change-classifier、staleness、search、embedding-search、analyzer 系列、ignore-filter、languages 注册表）近原样 vendor 进 Kocode，不重写其核心算法，且不因性能或安全顾虑而替换上游算法实现。
2. THE 实现 SHALL 将上游 llm-analyzer 的后端替换为 Kocode 的 Flash_Model_Client，同时保留其算法结构。
3. THE 实现 SHALL 将上游 tree-sitter 调用层接入 Kocode 现有的 wasm Tree_Sitter_Service，不使用原生 node tree-sitter 绑定。
4. THE 实现 SHALL 丢弃上游 plugins、agents、dashboard、install 脚本、slash 平台壳与多平台分发机制，且不暴露 `/understand*` 作为产品入口。

## 超出本期范围（Out of Scope）

以下内容明确不在本期交付范围内，但 schema 为其预留结构：

1. **可视化（Project Map）**：本期不实现图谱的图形化可视化界面；`kocode.knowledge.openProjectMap` 仅占位/禁用。可视化将作为后续独立阶段实现。
2. **Wiki 知识库分析**：上游 `/understand-knowledge` 与 `article-analyzer` 相关能力推迟，列为可选，不在本期核心目标线上。
3. **抽取为 SDK / CLI**：第一版只做 Kocode VS Code 扩展，不抽象到独立 SDK 或 CLI。
4. **保存即实时分析**：自动更新以 git commit 后为准，不做保存即实时分析。
5. **与上游持续同步**：迁入后按 Kocode 风格独立维护，不追求与上游同步。

## 假设（Assumptions）

1. 第一版只做 Kocode VS Code 扩展，不抽到 SDK/CLI。
2. 迁入后彻底按 Kocode 风格维护，不追求与上游同步。
3. 自动更新以 git commit 后为准，不做保存即实时分析。
4. 图谱默认自动参与 Worker 上下文，但必须有 token 上限与 stale 降级。
5. VS Code 扩展环境只能使用 wasm 版 tree-sitter，不能使用原生 node 绑定（硬约束）。
6. 语义生成复用现有 Flash_Model_Client（deepseek-v4-flash），不引入新模型配置。
