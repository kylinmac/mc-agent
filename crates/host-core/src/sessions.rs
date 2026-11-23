mod fork_files;
mod message_parents;
mod model_system;
mod usage;
pub use usage::{record_usage, session_usage_cost};

mod types;
pub use types::*;
mod titles;
pub use titles::{
    auto_title_context, derive_session_title, normalize_session_title, rename_session,
    set_automatic_session_title,
};
mod message_codec;
pub(crate) use message_codec::{record_to_ui, ui_to_record};
mod display;
use display::{record_to_ui_for_display, DISPLAY_TRUNCATION_MARKER};
mod index;
pub(crate) use index::{dedupe_records, insert_index_row, record_index_text};
mod fork;
pub use fork::{fork_session_through, session_has_running_turn, ForkSessionResult};
mod recovery;
pub use recovery::*;
mod queries;
pub use queries::{
    get_session, get_session_with_options, list_sessions, session_exists, session_mode,
    session_permission_mode, session_summary,
};
pub(crate) use queries::{session_layout, summary_from_row};
mod lifecycle;
pub use lifecycle::*;
pub(crate) use lifecycle::{delete_session_row, remove_deleted_session_files};
mod append;
pub use append::*;
mod revisions;
pub use revisions::*;
mod turns;
pub use turns::*;
mod search;
pub use search::search_messages;
mod usage_history;
pub use usage_history::get_token_usage_history;

#[cfg(test)]
mod tests;
