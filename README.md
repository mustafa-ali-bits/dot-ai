# DOT AI - Self-Hosted AI Coding Agent

> **Forked from [All-Hands-AI/open-swe](https://github.com/All-Hands-AI/open-swe)** with Docker mode support and local execution capabilities.

An autonomous AI-powered software engineering agent that can plan, code, and create pull requests on your GitHub repositories. This fork adds **Docker-based sandbox execution** for self-hosted deployments.

## 🌟 Features

- **Autonomous Coding**: Give it a GitHub issue, it plans and implements the solution
- **GitHub Integration**: Full OAuth, webhooks, and PR creation
- **Multiple LLM Support**: Gemini, Claude, OpenAI, and more
- **Docker Mode** *(New)*: Run in isolated Docker containers without Daytona
- **Local Mode** *(New)*: Test on local projects without sandboxes

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                  Next.js Web App (:3000)                     │
│  - Dashboard UI                                              │
│  - GitHub OAuth                                              │
│  - Task Management                                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│               LangGraph Agent Server (:2024)                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Planner   │  │ Programmer  │  │  Reviewer   │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐      ┌─────────┐      ┌─────────────┐
   │ LLM API │      │ GitHub  │      │   Sandbox   │
   │ (Gemini)│      │   API   │      │(Docker/Local)│
   └─────────┘      └─────────┘      └─────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Yarn
- Git
- Docker (optional, for Docker mode)
- A GitHub App (see [GitHub App Setup](#github-app-setup))
- A Gemini API key (or other LLM provider)

### Installation

```bash
# Clone this fork
git clone https://github.com/your-username/open-swe-fork.git
cd open-swe-fork

# Install dependencies
yarn install
```

### Environment Setup

1. **Agent Configuration** (`apps/open-swe/.env`):

```bash
# LLM Configuration
GOOGLE_API_KEY="your-gemini-api-key"

# GitHub App
GITHUB_APP_NAME="your-app-name"
GITHUB_APP_ID="your-app-id"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...your private key...
-----END RSA PRIVATE KEY-----"
GITHUB_APP_CLIENT_ID="your-client-id"
GITHUB_APP_CLIENT_SECRET="your-client-secret"
GITHUB_WEBHOOK_SECRET="your-webhook-secret"

# Security
SECRETS_ENCRYPTION_KEY="your-32-byte-hex-key"

# Execution Mode (choose one)
OPEN_SWE_LOCAL_MODE="true"           # For local development
# OPEN_SWE_DOCKER_MODE="true"        # For Docker sandbox
```

2. **Web App Configuration** (`apps/web/.env`):

```bash
NEXT_PUBLIC_GITHUB_APP_CLIENT_ID="your-client-id"
GITHUB_APP_CLIENT_SECRET="your-client-secret"
GITHUB_APP_REDIRECT_URI="http://localhost:3000/api/auth/github/callback"

GITHUB_APP_NAME="your-app-name"
GITHUB_APP_ID="your-app-id"
GITHUB_APP_PRIVATE_KEY="..."

NEXT_PUBLIC_API_URL="http://localhost:3000/api"
LANGGRAPH_API_URL="http://localhost:2024"
SECRETS_ENCRYPTION_KEY="same-key-as-agent"

NEXT_PUBLIC_LOCAL_MODE="true"
```

### Running the Application

**Start both servers:**

```bash
# Terminal 1: LangGraph Agent
cd apps/open-swe
yarn dev
# Runs on http://localhost:2024

# Terminal 2: Web App
cd apps/web
yarn dev
# Runs on http://localhost:3000
```

Open http://localhost:3000 in your browser.

## 🔐 GitHub App Setup

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**

2. Configure the app:
   - **Name**: `your-app-name`
   - **Homepage URL**: `http://localhost:3000`
   - **Callback URL**: `http://localhost:3000/api/auth/github/callback`
   - **Webhook URL**: `http://your-public-url/webhooks/github` (use ngrok for local)
   - **Webhook Secret**: Generate a secure secret

3. **Permissions**:
   - Repository: Contents (Read & Write), Pull Requests (Read & Write), Issues (Read & Write)
   - Account: Email (Read)

4. After creation, generate a **Private Key** and note your **App ID**, **Client ID**, and **Client Secret**.

5. Install the app on your repositories.

## 🐳 Docker Mode (Self-Hosted)

For production deployments, Docker mode provides isolated sandbox execution:

```bash
# Build the Docker image
cd docker
docker build -t open-swe-sandbox .

# Set OPEN_SWE_DOCKER_MODE=true in your .env
```

The Docker sandbox includes:
- Ubuntu 22.04 base
- Node.js 20, Python 3.11, Go 1.21, Rust
- Git, ripgrep, fd, and common dev tools

## 🤖 Supported LLM Providers

| Provider | Models | Environment Variable |
|----------|--------|---------------------|
| Google | gemini-2.5-pro, gemini-2.5-flash | `GOOGLE_API_KEY` |
| Anthropic | claude-opus-4-5, claude-sonnet-4 | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-5-codex, gpt-5-turbo | `OPENAI_API_KEY` |

Configure in `apps/open-swe/src/utils/llms/model-manager.ts`.

## 📁 Project Structure

```
open-swe-fork/
├── apps/
│   ├── open-swe/          # LangGraph Agent Server
│   │   ├── src/
│   │   │   ├── graphs/    # Agent graphs (planner, programmer, reviewer)
│   │   │   ├── tools/     # Agent tools (shell, file ops, git)
│   │   │   └── utils/     # Utilities (sandbox, LLM, GitHub)
│   │   └── .env           # Agent configuration
│   └── web/               # Next.js Web Application
│       ├── src/
│       │   ├── app/       # Next.js app router
│       │   └── components/# React components
│       └── .env           # Web app configuration
├── packages/
│   └── shared/            # Shared types and utilities
├── docker/                # Docker sandbox configuration
└── libs/
    └── sdk-typescript/    # Daytona SDK (optional)
```

## 🔧 Key Modifications in This Fork

1. **Local Mode**: Execute on local filesystem without Daytona
2. **Docker Mode**: Isolated Docker container sandbox
3. **macOS Shell Fix**: Proper shell path detection for macOS
4. **Gemini 2.5 Support**: Updated model configurations
5. **Enhanced Error Handling**: Better sandbox stop/delete in local mode

## 🤝 Contributing

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `yarn test`
5. Commit: `git commit -am 'Add my feature'`
6. Push: `git push origin feature/my-feature`
7. Create a Pull Request

## 📄 License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

- Original [Open SWE](https://github.com/All-Hands-AI/open-swe) by All-Hands-AI
- [LangGraph](https://github.com/langchain-ai/langgraph) for agent orchestration
- [Daytona](https://www.daytona.io/) for the original sandbox infrastructure
