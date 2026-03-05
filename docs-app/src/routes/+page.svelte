<script>
	import Intro from '$lib/content/intro.md';
</script>

<div class="bg-effects">
	<div class="grid-pattern"></div>
</div>

<header>
	<div class="header-content">
		<div class="logo">
			<div class="logo-icon">⚡</div>
			<span>Zveltio</span>
		</div>
		<nav>
			<a href="#features">Features</a>
			<a href="#extensions">Extensions</a>
			<a href="#about">About</a>
			<a href="/installation">Documentation</a>
		</nav>
		<a href="/installation" class="cta-button">Get Started</a>
	</div>
</header>

<section class="hero">
	<div class="hero-content">
		<div class="hero-badge"><span>🚀</span> Built with Bun + Hono</div>
		<h1>
			The Operating System for <span>Your Business</span> Applications
		</h1>
		<p class="hero-subtitle">
			Zveltio isn't just a database with an API on top. It's a
			high-performance engine, distributed as a single executable, over
			which you install the business logic you need—exactly how you install
			apps on a PC.
		</p>
		<p class="hero-subtitle">
			Stop rewriting code from scratch for every project. Install the
			foundation, choose your extensions, and launch to production.
		</p>
		<div class="hero-cta">
			<a href="/installation" class="btn-primary">
				Get Started with Zveltio
				<span>→</span>
			</a>
			<a href="/architecture" class="btn-secondary"> Explore Architecture </a>
		</div>
	</div>
</section>

<section class="stats-section">
	<div class="stats-grid">
		<div class="stat-item">
			<h3>10x</h3>
			<p>Faster than Node.js</p>
		</div>
		<div class="stat-item">
			<h3>100%</h3>
			<p>Type-Safe</p>
		</div>
		<div class="stat-item">
			<h3>0</h3>
			<p>Downtime DDL</p>
		</div>
		<div class="stat-item">
			<h3>∞</h3>
			<p>Extensible</p>
		</div>
	</div>
</section>

<section class="section" id="about">
	<div class="section-header">
		<span class="section-label">🛑 The Problem</span>
		<h2>Why We Built Zveltio</h2>
		<p>
			If you're a developer or run a software agency, you know the story:
		</p>
	</div>
	<div class="problem-grid">
		<div class="problem-card">
			<div class="problem-icon">📉</div>
			<h3>BaaS Platforms Abandon You</h3>
			<p>
				They help you quickly build an MVP, but leave you hanging when it
				comes to complex business logic.
			</p>
		</div>
		<div class="problem-card">
			<div class="problem-icon">💰</div>
			<h3>Enterprise Solutions Are Too Expensive</h3>
			<p>
				They're rigid, lock you into their ecosystem, and cost a fortune
				monthly.
			</p>
		</div>
		<div class="problem-card">
			<div class="problem-icon">♻️</div>
			<h3>Classic Frameworks</h3>
			<p>
				Force you to write the same "boilerplate" infinitely: CRUD, Auth,
				Permissions.
			</p>
		</div>
	</div>
</section>

<section class="how-it-works" id="architecture">
	<div class="section-header">
		<span class="section-label">💡 The Solution</span>
		<h2>How It Works</h2>
		<p>
			A modular monolith architecture that gives you the best of both worlds:
			simplicity of deployment and flexibility of microservices.
		</p>
	</div>
	<div class="arch-diagram">
		<div class="arch-layer">
			<h3>🎨 Studio</h3>
			<p>Admin Interface</p>
		</div>
		<div class="arch-connector">→</div>
		<div class="arch-layer">
			<h3>⚡ Engine</h3>
			<p>API Gateway</p>
		</div>
		<div class="arch-connector">→</div>
		<div class="arch-layer">
			<h3>🗄️ Data</h3>
			<p>PostgreSQL + Valkey</p>
		</div>
	</div>
</section>

<section class="features" id="features">
	<h2>Built for Modern Development</h2>
	<div class="features-grid">
		<div class="feature-card">
			<div class="feature-icon">🚀</div>
			<h3>Blazing Fast</h3>
			<p>Built on Bun + Hono for exceptional performance</p>
		</div>
		<div class="feature-card">
			<div class="feature-icon">🔒</div>
			<h3>Secure by Default</h3>
			<p>Enterprise-grade authentication & authorization</p>
		</div>
		<div class="feature-card">
			<div class="feature-icon">🧩</div>
			<h3>Extensible</h3>
			<p>Plugin-based architecture for custom extensions</p>
		</div>
		<div class="feature-card">
			<div class="feature-icon">☁️</div>
			<h3>Self-Hosted</h3>
			<p>Full control with Docker deployment</p>
		</div>
		<div class="feature-card">
			<div class="feature-icon">🤖</div>
			<h3>AI-Powered</h3>
			<p>Universal AI provider integration</p>
		</div>
		<div class="feature-card">
			<div class="feature-icon">📊</div>
			<h3>Monitoring</h3>
			<p>Built-in Prometheus & Grafana dashboards</p>
		</div>
	</div>
</section>

<section class="extensions-section" id="extensions">
	<h2>Extensions Ecosystem</h2>
	<p class="section-desc">Pre-built integrations for common business needs</p>
	<div class="extensions-grid">
		<div class="extension-card">
			<div class="extension-icon">🤖</div>
			<h3>AI Integration</h3>
			<p>Chat, embeddings, and semantic search</p>
		</div>
		<div class="extension-card">
			<div class="extension-icon">🔄</div>
			<h3>Automation</h3>
			<p>Visual workflow builder</p>
		</div>
		<div class="extension-card">
			<div class="extension-icon">📄</div>
			<h3>Compliance</h3>
			<p>Romanian eFactura, documents</p>
		</div>
		<div class="extension-card">
			<div class="extension-icon">🌐</div>
			<h3>Geospatial</h3>
			<p>PostGIS integration</p>
		</div>
		<div class="extension-card">
			<div class="extension-icon">📝</div>
			<h3>Page Builder</h3>
			<p>Dynamic content pages</p>
		</div>
		<div class="extension-card">
			<div class="extension-icon">⚡</div>
			<h3>Edge Functions</h3>
			<p>Serverless custom logic</p>
		</div>
	</div>
</section>

<section class="cta-section" id="get-started">
	<div class="cta-content">
		<h2>Ready to Get Started?</h2>
		<p>Install Zveltio in minutes and start building your next application.</p>
		<div class="hero-cta">
			<a href="/installation" class="btn-primary">Install Now →</a>
			<a href="/architecture" class="btn-secondary">Learn More</a>
		</div>
	</div>
</section>

<footer>
	<div class="footer-content">
		<div class="footer-brand">
			<div class="logo">
				<span class="logo-icon">⚡</span>
				<span>Zveltio</span>
			</div>
			<p>The Operating System for Your Business Applications</p>
		</div>
		<div class="footer-links">
			<a href="/installation">Documentation</a>
			<a href="https://github.com/zveltio/zveltio" target="_blank">GitHub</a>
			<a href="/security">Security</a>
		</div>
		<p class="footer-copy">Built with Bun ❤️ for Enterprises</p>
	</div>
</footer>

<style>
	/* Background Effects */
	.bg-effects {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: -1;
		overflow: hidden;
	}

	.bg-effects::before {
		content: '';
		position: absolute;
		top: -50%;
		left: -50%;
		width: 200%;
		height: 200%;
		background:
			radial-gradient(ellipse at 20% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
			radial-gradient(ellipse at 80% 80%, rgba(139, 92, 246, 0.06) 0%, transparent 50%),
			radial-gradient(ellipse at 50% 50%, rgba(168, 85, 247, 0.04) 0%, transparent 60%);
		animation: bgPulse 15s ease-in-out infinite;
	}

	@keyframes bgPulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.7; transform: scale(1.1); }
	}

	.grid-pattern {
		position: absolute;
		width: 100%;
		height: 100%;
		background-image:
			linear-gradient(rgba(99, 102, 241, 0.03) 1px, transparent 1px),
			linear-gradient(90deg, rgba(99, 102, 241, 0.03) 1px, transparent 1px);
		background-size: 60px 60px;
		mask-image: radial-gradient(ellipse at center, black 30%, transparent 70%);
	}

	/* Header */
	header {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 100;
		padding: 1rem 2rem;
		background: rgba(10, 10, 15, 0.8);
		backdrop-filter: blur(20px);
		border-bottom: 1px solid var(--border-color);
	}

	.header-content {
		max-width: 1400px;
		margin: 0 auto;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 1.5rem;
		font-weight: 700;
		background: var(--accent-gradient);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.logo-icon {
		-webkit-text-fill-color: initial;
		width: 36px;
		height: 36px;
		background: var(--accent-gradient);
		border-radius: 10px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
	}

	nav {
		display: flex;
		gap: 2rem;
		align-items: center;
	}

	nav a {
		color: var(--text-secondary);
		text-decoration: none;
		font-weight: 500;
		font-size: 0.9rem;
		transition: color 0.2s;
	}

	nav a:hover {
		color: var(--text-primary);
	}

	.cta-button {
		padding: 0.75rem 1.5rem;
		background: var(--accent-gradient);
		border: none;
		border-radius: 10px;
		color: white;
		font-weight: 600;
		font-size: 0.9rem;
		cursor: pointer;
		transition: transform 0.2s, box-shadow 0.2s;
		text-decoration: none;
	}

	.cta-button:hover {
		transform: translateY(-2px);
		box-shadow: 0 10px 40px rgba(99, 102, 241, 0.3);
	}

	/* Hero Section */
	.hero {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8rem 2rem 4rem;
		text-align: center;
	}

	.hero-content {
		max-width: 900px;
	}

	.hero-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		background: rgba(99, 102, 241, 0.1);
		border: 1px solid rgba(99, 102, 241, 0.3);
		border-radius: 100px;
		font-size: 0.85rem;
		color: var(--accent-primary);
		margin-bottom: 2rem;
	}

	.hero h1 {
		font-size: clamp(2.5rem, 6vw, 4.5rem);
		font-weight: 800;
		line-height: 1.1;
		margin-bottom: 1.5rem;
		letter-spacing: -0.02em;
	}

	.hero h1 span {
		background: var(--accent-gradient);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.hero-subtitle {
		font-size: 1.25rem;
		color: var(--text-secondary);
		margin-bottom: 1.5rem;
		max-width: 700px;
		margin-left: auto;
		margin-right: auto;
	}

	.hero-cta {
		display: flex;
		gap: 1rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-top: 2rem;
	}

	.btn-primary {
		padding: 1rem 2rem;
		background: var(--accent-gradient);
		border: none;
		border-radius: 12px;
		color: white;
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.3s;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.btn-primary:hover {
		transform: translateY(-3px);
		box-shadow: 0 20px 60px rgba(99, 102, 241, 0.4);
	}

	.btn-secondary {
		padding: 1rem 2rem;
		background: var(--bg-card);
		border: 1px solid var(--border-color);
		border-radius: 12px;
		color: var(--text-primary);
		font-weight: 600;
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.3s;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.btn-secondary:hover {
		background: var(--bg-card-hover);
		border-color: var(--accent-primary);
	}

	/* Stats Section */
	.stats-section {
		padding: 4rem 2rem;
		background: var(--bg-secondary);
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 2rem;
		max-width: 1000px;
		margin: 0 auto;
		text-align: center;
	}

	.stat-item h3 {
		font-size: 3rem;
		font-weight: 800;
		background: var(--accent-gradient);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		margin-bottom: 0.5rem;
	}

	.stat-item p {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin: 0;
	}

	/* Sections */
	.section {
		padding: 6rem 2rem;
		max-width: 1200px;
		margin: 0 auto;
	}

	.section-header {
		text-align: center;
		margin-bottom: 4rem;
	}

	.section-label {
		display: inline-block;
		padding: 0.5rem 1rem;
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.3);
		border-radius: 100px;
		color: #ef4444;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 1rem;
	}

	.section h2 {
		font-size: 2.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
	}

	.section p {
		font-size: 1.1rem;
		color: var(--text-secondary);
		max-width: 600px;
		margin: 0 auto;
	}

	.section-desc {
		text-align: center;
		margin-bottom: 3rem;
	}

	/* Problem Grid */
	.problem-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1.5rem;
	}

	.problem-card {
		background: var(--bg-card);
		border: 1px solid var(--border-color);
		border-radius: 16px;
		padding: 2rem;
		transition: all 0.3s;
	}

	.problem-card:hover {
		border-color: var(--accent-primary);
		transform: translateY(-4px);
	}

	.problem-icon {
		width: 48px;
		height: 48px;
		background: rgba(239, 68, 68, 0.1);
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		margin-bottom: 1rem;
	}

	.problem-card h3 {
		font-size: 1.25rem;
		font-weight: 600;
		margin-bottom: 0.75rem;
		color: var(--text-primary);
	}

	.problem-card p {
		color: var(--text-secondary);
		font-size: 0.95rem;
		margin: 0;
		text-align: left;
	}

	/* How It Works */
	.how-it-works {
		background: var(--bg-secondary);
		padding: 6rem 2rem;
	}

	.arch-diagram {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		align-items: center;
		max-width: 1000px;
		margin: 0 auto;
	}

	@media (min-width: 768px) {
		.arch-diagram {
			flex-direction: row;
			justify-content: center;
		}
	}

	.arch-layer {
		background: var(--bg-card);
		border: 1px solid var(--border-color);
		border-radius: 16px;
		padding: 2rem;
		text-align: center;
		flex: 1;
		max-width: 320px;
		transition: all 0.3s;
	}

	.arch-layer:hover {
		border-color: var(--accent-primary);
		transform: scale(1.02);
	}

	.arch-layer h3 {
		font-size: 1.25rem;
		font-weight: 700;
		margin-bottom: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.arch-layer p {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.arch-connector {
		display: none;
		color: var(--accent-primary);
		font-size: 2rem;
		padding: 2rem 0;
	}

	@media (min-width: 768px) {
		.arch-connector {
			display: block;
		}
	}

	/* Features */
	.features {
		padding: 6rem 2rem;
	}

	.features h2 {
		text-align: center;
		margin-bottom: 3rem;
	}

	.features-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.5rem;
		max-width: 1200px;
		margin: 0 auto;
	}

	.feature-card {
		background: var(--bg-card);
		border: 1px solid var(--border-color);
		border-radius: 16px;
		padding: 2rem;
		transition: all 0.3s;
	}

	.feature-card:hover {
		border-color: var(--accent-secondary);
		transform: translateY(-4px);
	}

	.feature-icon {
		width: 56px;
		height: 56px;
		background: var(--accent-gradient);
		border-radius: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.75rem;
		margin-bottom: 1.5rem;
	}

	.feature-card h3 {
		font-size: 1.2rem;
		font-weight: 600;
		margin-bottom: 0.75rem;
		color: var(--text-primary);
	}

	.feature-card p {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin: 0;
		text-align: left;
	}

	/* Extensions */
	.extensions-section {
		background: var(--bg-secondary);
		padding: 6rem 2rem;
	}

	.extensions-section h2 {
		text-align: center;
		margin-bottom: 1rem;
	}

	.extensions-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 1.5rem;
		max-width: 1200px;
		margin: 0 auto;
	}

	.extension-card {
		background: var(--bg-card);
		border: 1px solid var(--border-color);
		border-radius: 16px;
		padding: 1.5rem;
		transition: all 0.3s;
		cursor: pointer;
	}

	.extension-card:hover {
		border-color: var(--success);
		transform: translateY(-4px);
	}

	.extension-icon {
		width: 44px;
		height: 44px;
		background: rgba(16, 185, 129, 0.1);
		border: 1px solid rgba(16, 185, 129, 0.3);
		border-radius: 10px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
		margin-bottom: 1rem;
	}

	.extension-card h3 {
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
		color: var(--text-primary);
	}

	.extension-card p {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0;
		text-align: left;
	}

	/* CTA Section */
	.cta-section {
		padding: 6rem 2rem;
		text-align: center;
	}

	.cta-content h2 {
		font-size: 2.5rem;
		margin-bottom: 1rem;
	}

	.cta-content p {
		font-size: 1.25rem;
		color: var(--text-secondary);
		margin-bottom: 2rem;
	}

	/* Footer */
	footer {
		background: var(--bg-secondary);
		padding: 4rem 2rem 2rem;
		border-top: 1px solid var(--border-color);
	}

	.footer-content {
		max-width: 1200px;
		margin: 0 auto;
		text-align: center;
	}

	.footer-brand {
		margin-bottom: 2rem;
	}

	.footer-brand p {
		color: var(--text-secondary);
		margin-top: 0.5rem;
	}

	.footer-links {
		display: flex;
		gap: 2rem;
		justify-content: center;
		margin-bottom: 2rem;
	}

	.footer-links a {
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.9rem;
		transition: color 0.2s;
	}

	.footer-links a:hover {
		color: var(--text-primary);
	}

	.footer-copy {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	/* Responsive */
	@media (max-width: 768px) {
		nav {
			display: none;
		}

		.hero h1 {
			font-size: 2rem;
		}

		.section h2 {
			font-size: 1.75rem;
		}
	}
</style>
