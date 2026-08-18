CREATE TABLE projects (
    id BINARY(16) NOT NULL PRIMARY KEY,
    slug VARCHAR(120) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    curator VARCHAR(200) NOT NULL,
    location VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);

CREATE TABLE assets (
    id BINARY(16) NOT NULL PRIMARY KEY,
    project_id BINARY(16) NOT NULL,
    slug VARCHAR(120) NOT NULL UNIQUE,
    title VARCHAR(240) NOT NULL,
    artist VARCHAR(200) NOT NULL,
    creation_year SMALLINT UNSIGNED NOT NULL,
    medium VARCHAR(240) NOT NULL,
    location VARCHAR(200) NOT NULL,
    valuation_usd DECIMAL(20, 2) NOT NULL,
    lifecycle_status VARCHAR(40) NOT NULL,
    metadata_json JSON NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_assets_project FOREIGN KEY (project_id) REFERENCES projects (id),
    CONSTRAINT chk_assets_valuation CHECK (valuation_usd > 0)
);

CREATE INDEX idx_assets_project_status ON assets (project_id, lifecycle_status);
