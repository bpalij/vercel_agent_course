# vercel_agent_course

Tutorial: [Vercel Academy](https://vercel.com/academy/build-ai-agent-harness)
Note: Uses Anthropic API by default

## Requirements

### Environment Variables (.env file)

You need to set up a `.env` file with the following:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key  # Required - for Anthropic Claude model
AI_GATEWAY_API_KEY=your_gateway_api_key   # Optional - for Vercel AI Gateway
```

- **ANTHROPIC_API_KEY**: Required. Get from https://console.anthropic.com
- **AI_GATEWAY_API_KEY**: Optional. Get from your Vercel project settings

### Prerequisites
- [Bun](https://bun.com) runtime installed (v1.4.2 or later recommended)
- Anthropic API account with valid API key

## Installation
To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
