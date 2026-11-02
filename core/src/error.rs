use core::fmt;

use crate::graph::SporeId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// A spore cannot pay itself or hold a tube to itself.
    SelfEdge(SporeId),
    /// An edge or flow names a spore that is not in the active list.
    InactiveSpore(SporeId),
    BadParams(&'static str),
    Overflow,
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::SelfEdge(id) => write!(f, "spore {id} cannot trade with itself"),
            CoreError::InactiveSpore(id) => write!(f, "spore {id} is not active"),
            CoreError::BadParams(why) => write!(f, "bad params: {why}"),
            CoreError::Overflow => write!(f, "arithmetic overflow"),
        }
    }
}

impl std::error::Error for CoreError {}
