//! LOCAL DIVERGENCE: finding uploads nothing uses any more, so the relay can
//! reclaim their storage. Upstream keeps every blob.
//!
//! "Uses" is deliberately broader than the media read gate: any live event in
//! the community whose tags or content mention the hash, a stored profile
//! avatar, or the community icon. A false "still used" only delays reclaiming;
//! a false "unused" destroys a file someone still shows.

use sqlx::PgConnection;
use uuid::Uuid;

use crate::{CommunityId, Db, Result};

/// Media hashes named by `imeta` tags of `ids`, read before those rows go.
pub(crate) async fn media_hashes_of_events(
    conn: &mut PgConnection,
    community_id: CommunityId,
    ids: &[Vec<u8>],
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT lower(m[1]) FROM events e \
           CROSS JOIN LATERAL jsonb_array_elements(e.tags) AS t(tag) \
           CROSS JOIN LATERAL regexp_matches(t.tag::text, '([0-9A-Fa-f]{64})', 'g') AS m \
          WHERE e.community_id = $1 AND e.id = ANY($2) AND t.tag->>0 = 'imeta'",
    )
    .bind(community_id.as_uuid())
    .bind(ids)
    .fetch_all(conn)
    .await?)
}

impl Db {
    /// The hashes among `hashes` that nothing in this community uses any more.
    pub async fn unused_media(
        &self,
        community_id: CommunityId,
        hashes: &[String],
    ) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT h FROM unnest($2::text[]) AS h \
              WHERE NOT EXISTS (SELECT 1 FROM events e \
                                 WHERE e.community_id = $1 AND e.deleted_at IS NULL \
                                   AND (strpos(lower(e.tags::text), h) > 0 \
                                        OR strpos(lower(e.content), h) > 0)) \
                AND NOT EXISTS (SELECT 1 FROM users u \
                                 WHERE u.community_id = $1 \
                                   AND strpos(lower(coalesce(u.avatar_url, '')), h) > 0) \
                AND NOT EXISTS (SELECT 1 FROM communities c \
                                 WHERE c.id = $1 \
                                   AND strpos(lower(coalesce(c.icon, '')), h) > 0)",
        )
        .bind(community_id.as_uuid())
        .bind(hashes)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Drop this community's upload and publication records for `sha256`,
    /// which exist only when media access checks are on.
    pub async fn forget_media(&self, community_id: CommunityId, sha256: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for statement in [
            "DELETE FROM media_uploaders WHERE community_id = $1 AND sha256 = $2",
            "DELETE FROM media_publications WHERE community_id = $1 AND sha256 = $2",
        ] {
            sqlx::query(statement)
                .bind(community_id.as_uuid())
                .bind(sha256)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Every community, for finding which of them keep a sidecar for a hash.
    pub async fn media_community_ids(&self) -> Result<Vec<CommunityId>> {
        let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM communities")
            .fetch_all(&self.pool)
            .await?;
        Ok(ids.into_iter().map(CommunityId::from_uuid).collect())
    }
}
