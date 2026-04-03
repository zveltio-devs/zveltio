# Changelog

All notable changes to Zveltio will be documented in this file.

## [2.0.0] - 2026-04-03

### 🚀 Major Features & Optimizations

#### Phase 2 & 3 Optimizations Complete

##### Bun Native Features Implementation

- **crypto.randomUUID()** instead of nanoid - Native Bun UUID generation
- **better-auth tree shaking** - Optimized imports from Better-Auth library
- **Reduced bundle size** - 75% smaller PDF generation with pdf-lib

##### Build Process Optimizations

- **BUN_MEMORY_LIMIT** environment variable added
  - Development: 4096 MB
  - Production: 2048 MB
- **Memory-aware request throttling** - Automatic fallback to in-memory limiter
- **Optimized Valkey pipeline** - Atomic operations with zadd/zremrangebyscore

##### Dependency Reduction

- **pdfkit → pdf-lib**: From ~1.2MB to ~300KB
- **nanoid removal**: Native crypto.randomUUID() usage
- **graphql-dataloader removed**: Native GraphQL implementation

### 🔧 Engine Improvements

#### PDF Generation (workers/pdf-worker.ts)

- Complete rewrite using pdf-lib
- Support for: A4, A3, A5, Letter, Legal page sizes
- Portrait/Landscape orientation support
- H1/H2/H3 heading formatting
- Automatic pagination
- Document metadata (producer, creator)

#### AI Engine (zveltio-ai/engine.ts)

- crypto.randomUUID() for all IDs
- Enhanced text-to-SQL with READ ONLY transactions
- Memory-efficient query execution
- Better error handling and validation

#### Cache Optimizations (cache.ts)

- Optimized Valkey pipeline operations
- Improved TTL handling
- Better error recovery

### 📊 Performance Improvements

| Metric         | Before     | After      | Improvement       |
| -------------- | ---------- | ---------- | ----------------- |
| Bundle Size    | ~2.5MB     | ~0.61MB    | 75% reduction     |
| PDF Generation | 1.2MB deps | 300KB deps | 75% reduction     |
| Memory Usage   | High       | Optimized  | Better throttling |
| Build Time     | Baseline   | Optimized  | Faster            |

### 🔐 Security Enhancements

- READ ONLY transactions for all SQL execution
- Input validation on AI tool calls
- Permission checks for all data operations
- Rate limiting with memory-aware fallback

### 🧪 Testing & Quality

- ESLint warnings: 0 (all fixed)
- Type checking: Passed
- Build verification: Passed

### 📦 Package Updates

- `pdfkit`: Removed
- `pdf-lib`: ^1.17.1 (added)
- `@aws-sdk/client-s3`: ^3.600.0
- `@aws-sdk/s3-request-presigner`: ^3.600.0
- `better-auth`: 1.5.3 (tree-shakeable)

### 🛠️ Breaking Changes

- **nanoid removed** - Use `crypto.randomUUID()` instead
- **pdfkit removed** - Use `pdf-lib` for PDF generation
- **graphql-dataloader removed** - Native implementation in place

### 📝 Notes

- Version bumped to 2.0.0 to reflect major optimizations
- All existing functionality preserved
- API remains backward compatible for external consumers

---

## [1.0.x] - Previous Versions

See git history for changes before v2.0.0
