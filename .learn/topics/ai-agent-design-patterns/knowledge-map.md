# AI Agent Design Patterns

> 0/25 mastered · 0% complete

## Agent Foundations

- ⚪ **The Agent Loop** (unexplored)
  - Observe → think → act cycle
  - Termination conditions & max iterations
  - Repo: 07\_simple-agent
- ⚪ **Prompts as Programs** (unexplored)
  - System vs user prompt hierarchy
  - Prompt templates & few-shot examples
  - Repo: PROMPTING.md, 04\_think
- ⚪ **Context Window Management** (unexplored)
  - Token budgets & truncation strategies
  - Summarization & compaction
  - Context rot vs context relevance
- ⚪ **Structured Output & Validation** (unexplored)
  - JSON mode & schema-constrained decoding
  - Parsing, retries on malformed output

## Tool Use

- ⚪ **Tool Definitions & Schemas** (unexplored)
  - JSON Schema for parameters
  - Descriptions as the real API contract
- ⚪ **Tool Execution Loop** (unexplored)
  - Tool-call → result → continue cycle
  - Parallel vs sequential tool calls
  - Repo: 07\_simple-agent, 09\_react-agent
- ⚪ **Tool Routing with Embeddings** (unexplored)
  - Scaling past the tool-count ceiling
  - Semantic selection of relevant tools
  - Repo: 15\_tool-routing-embeddings
- ⚪ **Model Context Protocol (MCP)** (unexplored)
  - Servers, clients, tools, resources
  - When MCP beats bespoke tool wiring

## Reasoning Patterns

- ⚪ **Chain of Thought (CoT)** (unexplored)
  - Step-by-step decomposition
  - Zero-shot vs few-shot CoT
  - Repo: 14\_chain-of-thought
- ⚪ **ReAct (Reason + Act)** (unexplored)
  - Thought / Action / Observation format
  - Repo: 09\_react-agent
- ⚪ **Tree of Thought (ToT)** (unexplored)
  - Branching exploration & backtracking
  - Evaluation & pruning of branches
  - Repo: 12\_tree-of-thought
- ⚪ **Graph of Thought (GoT)** (unexplored)
  - Merging & refining thought nodes
  - When graphs beat trees
  - Repo: 13\_graph-of-thought
- ⚪ **Atom of Thought (AoT)** (unexplored)
  - Atomic, composable reasoning steps
  - Repo: 10\_aot-agent
- ⚪ **Reflection & Self-Critique** (unexplored)
  - Generate → critique → revise loops
  - Self-consistency & verifier models
- ⚪ **Plan-and-Execute** (unexplored)
  - Upfront planning vs step-wise replanning
  - Plan repair on failure

## Memory & Knowledge

- ⚪ **Conversation Memory** (unexplored)
  - Short-term vs long-term memory
  - Sliding windows & memory files
  - Repo: 08\_simple-agent-with-memory
- ⚪ **Embeddings & Semantic Search** (unexplored)
  - Vector similarity & distance metrics
  - Chunking strategies
  - Repo: 15\_tool-routing-embeddings
- ⚪ **Retrieval-Augmented Generation (RAG)** (unexplored)
  - Retrieve → augment → generate pipeline
  - RAG vs long context vs fine-tuning

## Multi-Agent Orchestration

- ⚪ **Router & Dispatcher Patterns** (unexplored)
  - Intent classification & delegation
  - LLM router vs embedding router
- ⚪ **Subagents & Delegation** (unexplored)
  - Context isolation per subagent
  - Handoffs & result synthesis
  - Orchestrator-worker topology
- ⚪ **Workflows vs Agentic Loops** (unexplored)
  - Deterministic pipelines vs model-driven control flow
  - When NOT to build an agent

## Robustness & Production

- ⚪ **Error Handling & Retries** (unexplored)
  - Retry with backoff, fallbacks, timeouts
  - Malformed output recovery
  - Repo: 11\_error-handling
- ⚪ **Guardrails & Input Validation** (unexplored)
  - Prompt injection defenses
  - Output filtering & allowlists
- ⚪ **Agent Evaluation & Testing** (unexplored)
  - Evals: graded tasks & LLM-as-judge
  - Regression suites for prompts
- ⚪ **Observability & Tracing** (unexplored)
  - Logging every model call & tool result
  - Cost & latency tracking
