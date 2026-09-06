# ⚽ Futbolpedia – AI-Powered Football Analytics Engine

Futbolpedia is an advanced AI football (soccer) analyst that produces objective, data-driven player ratings and rankings across all eras. Unlike static databases or purely statistical models, Futbolpedia evaluates players holistically—exactly the way elite scouts and tactical analysts do.

Through a highly specialized prompt engineering framework and a custom React interface, this project leverages the Gemini 3.1 Pro/Flash models to deliver real-time scouting reports, in-depth tactical analysis, and a structured 25-attribute evaluation matrix.

## ✨ Key Features

- **Real-Time Data Pipelines:** Before answering a query, the system executes a "Factual Foundation" multi-vector search using Gemini's Google Search capabilities. This guarantees that all ratings and context are based on the latest up-to-date stats, form, and injury status.
- **Advanced Prompt Engineering:** Built on a rigorous "Master Instruction Set" with strict rulesets (e.g., "Anti-Hallucination Mandates," "Injury Quarantines," and "Tactical Role Primacy") that enforce objective, logic-driven responses.
- **Architected JSON Responses:** Converts unstructured natural language AI responses into a strictly defined JSON schema, parsing them down into an interactive UI featuring a comprehensive dossier, attribute tables, and strengths/weaknesses breakdowns.
- **Persistent Chat & Sharing:** Features a stateful, interactive chat interface built with React. Leverages `localStorage` for session persistence and integrates with Supabase to enable shareable URL states for generated player profiles.
- **Responsive "Dossier" UI:** A sleek, dark-mode compatible interface styled with Tailwind CSS, sliding out a dedicated dashboard whenever a new player profile or comparison is generated.

## 🛠 Technical Stack

- **Frontend:** React 19, TypeScript, Vite
- **Styling:** Tailwind CSS (Dark/Light mode support)
- **AI & Data Generation:** Google Gemini GenAI SDK (`@google/genai`) using `gemini-3.8-flash` (via `services/geminiService.ts` and `@futbolpedia/engine` for Gaffa outlooks)
- **Database & State Management:** Supabase (for profile sharing and URL persistence), standard React Hooks, `localStorage`
- **Parsing/Rendering:** DOMPurify, Marked

## 💡 Why This Stands Out (For Recruiters)

- **Complex AI Orchestration:** Demonstrates an understanding of how to constrain LLM behavior. The "Factual Foundation" approach is a manual implementation of RAG (Retrieval-Augmented Generation) patterns via live search tools, ensuring zero hallucination.
- **Robust Error Handling & State:** Safely parses LLM-generated JSON, sanitizes output types before dropping them into the UI, and cleanly catches API timeouts.
- **Full-Stack Mentality:** Manages the entire lifecycle of a user request—from taking input in a responsive chat UI, processing it through an AI workflow, parsing the structured result, updating local state, to persisting the generated data to a Supabase backend for sharing.

## 🚀 Getting Started

1. Clone the repository and run `npm install`.
2. Add your Gemini API Key and Supabase Config to `.env.local`.
3. Start the development server using `npm run dev`.
4. Ask the AI: *"Give me a scouting report on Bukayo Saka"* and watch the dossier build out in real time.
