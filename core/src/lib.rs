//! Spores core: the pure integer math shared by the router contract, `sim` and
//! `verify`. No floats, no chain dependency; every map iterates in key order
//! so identical inputs give identical bytes.

pub mod allowance;
pub mod epoch;
pub mod error;
pub mod fee;
pub mod fingerprint;
pub mod graph;
pub mod hiring;
pub mod market;
pub mod math;
pub mod params;
pub mod pool;
pub mod rng;

pub use epoch::{close_epoch, EpochInput, EpochOutput};
pub use error::CoreError;
pub use graph::{Edge, EdgeMap, RejectMap, SporeId};
pub use params::{Params, PoolRule, NEAR};
