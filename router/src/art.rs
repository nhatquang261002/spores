//! Art (SPEC §5.5). Two layers: the on-chain glyph (`spores_core::glyph`,
//! served as NEP-177 `media`) and the off-chain Physarum render, whose hash a
//! renderer operator (the admin) commits against the spore's stored state hash.
//! The router does not check the image; `verify` regenerates it from chain
//! state and compares.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::types::{emit, hex, unhex32, ImageCommit, SporeId};
use crate::{Router, RouterExt};

#[near(serializers=[json])]
pub struct ImageCommitView {
    pub epoch: u64,
    pub state_hash: String,
    pub image_hash: String,
    pub renderer_version: u32,
}

impl From<&ImageCommit> for ImageCommitView {
    fn from(c: &ImageCommit) -> Self {
        ImageCommitView {
            epoch: c.epoch,
            state_hash: hex(&c.state_hash),
            image_hash: hex(&c.image_hash),
            renderer_version: c.renderer_version,
        }
    }
}

#[near]
impl Router {
    /// Admin only. Commits `image_hash` (hex, `spores_renderer::image_hash`) for
    /// the spore's state at `epoch`, which must be the epoch of its stored state
    /// hash (written at each close). Replaces any earlier commit.
    pub fn commit_image(&mut self, spore_id: SporeId, epoch: u64, image_hash: String, renderer_version: u32) {
        require!(env::predecessor_account_id() == self.admin, "only the admin can commit images");
        let image_hash = unhex32(&image_hash, "image_hash");
        let s = self.spore_mut(spore_id);
        let Some((state_epoch, state_hash)) = s.state else {
            env::panic_str("spore has no state hash yet (it is set at the first close after activation)")
        };
        require!(epoch == state_epoch, "epoch does not match the spore's stored state hash");
        s.image = Some(ImageCommit { epoch, state_hash, image_hash, renderer_version });
        emit(
            "image_committed",
            json!({
                "spore_id": spore_id, "epoch": epoch, "state_hash": hex(&state_hash),
                "image_hash": hex(&image_hash), "renderer_version": renderer_version,
            }),
        );
    }

    pub fn image_commit(&self, spore_id: SporeId) -> Option<ImageCommitView> {
        self.spore(spore_id).image.as_ref().map(ImageCommitView::from)
    }

    /// The on-chain glyph: an integer-only SVG of the spore's tubes on the ring.
    pub fn glyph(&self, spore_id: SporeId) -> String {
        self.glyph_svg(spore_id)
    }
}

impl Router {
    pub(crate) fn glyph_svg(&self, id: SporeId) -> String {
        let s = self.spore(id);
        let t = self.traits(id);
        spores_core::glyph::glyph_svg(
            id,
            &s.seed,
            t.age.min(u32::MAX as u64) as u32,
            s.active,
            &self.connections(id),
        )
    }
}
