-- Custom migration: enable pgvector (vector column type + HNSW / IVFFlat indexes).
CREATE EXTENSION IF NOT EXISTS vector;
