//! Artboard HTML for the creative canvas (docs/mc-agent/creative-canvas.md).
//!
//! An artboard is an HTML *fragment* the agent wrote. This module reads it
//! strictly (every element closed, every attribute value quoted) so that the
//! same source always yields the same element numbering, and uses that
//! numbering three ways:
//!
//! - **Checking** a fragment before it is written: the artboard conventions.
//! - **Annotating** it when served: every start tag gets `data-mc-node="<n>"`,
//!   so the sandboxed frame can say which element was clicked by number only.
//! - **Resolving** a number (or a stored address) back to the element, with a
//!   label read from the source. Nothing the frame reports is used as text.
//!
//! Element `n` is the n-th element in document order (depth first, from 0),
//! counting every tag, `<style>` and `<script>` included. Its path is the
//! child position at each level from the top: `1/1/0`.

use std::collections::HashSet;

/// Largest artboard source accepted.
pub const MAX_BOARD_BYTES: usize = 512 * 1024;
const MAX_NODES: usize = 8_000;
/// Label text kept per element, in characters.
const LABEL_CHARS: usize = 60;
/// Addresses name elements at most this deep below a top-level element and
/// at most this many children in; deeper picks fall back to an ancestor.
const MAX_ADDRESS_DEPTH: usize = 9;
const MAX_ADDRESS_INDEX: usize = 99;

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title"];
/// Never allowed in an artboard: nested browsing contexts, document-level
/// tags, and anything that changes how the shell's head is read.
const FORBIDDEN: &[&str] = &[
    "html", "head", "body", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
    "base", "meta", "link",
];
/// Attribute the server writes; a fragment may not bring its own.
pub const NODE_ATTRIBUTE: &str = "data-mc-node";
pub const ID_ATTRIBUTE: &str = "data-mc-id";
/// `src="asset:<id>"` names an image of the project's library.
pub const ASSET_PREFIX: &str = "asset:";

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub tid: usize,
    pub path: Vec<usize>,
    pub tag: String,
    pub mc_id: Option<String>,
    alt: Option<String>,
    text: String,
    /// Byte offset just after the tag name, where an attribute can be added.
    name_end: usize,
}

impl Node {
    /// The element's first words (or an image's `alt`), for naming it back.
    pub fn label(&self) -> Option<String> {
        let text = collapse(&self.text);
        if !text.is_empty() {
            return Some(text.chars().take(LABEL_CHARS).collect());
        }
        self.alt
            .as_ref()
            .map(|alt| collapse(alt).chars().take(LABEL_CHARS).collect())
            .filter(|alt: &String| !alt.is_empty())
    }

    pub fn kind(&self) -> &'static str {
        match self.tag.as_str() {
            "img" | "picture" | "video" | "canvas" => "image",
            "line" | "polyline" | "path" => "line",
            _ if !collapse(&self.text).is_empty() => "text",
            "div" | "section" | "article" | "aside" | "svg" | "rect" | "circle" | "ellipse"
            | "polygon" | "span" | "figure" => "shape",
            _ => "other",
        }
    }

    pub fn path_string(&self) -> String {
        self.path
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join("/")
    }
}

/// An attribute value that names a library asset: its byte range and id.
#[derive(Debug, Clone, PartialEq)]
pub struct AssetRef {
    pub start: usize,
    pub end: usize,
    pub asset_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub nodes: Vec<Node>,
    pub assets: Vec<AssetRef>,
    reserved_attribute: bool,
    scripts: Vec<String>,
}

impl Parsed {
    pub fn node(&self, tid: usize) -> Option<&Node> {
        self.nodes.get(tid)
    }

    pub fn by_mc_id(&self, id: &str) -> Option<&Node> {
        self.nodes
            .iter()
            .find(|node| node.mc_id.as_deref() == Some(id))
    }

    /// The node an address names, only when its number and path still agree.
    pub fn by_address(&self, tid: usize, path: &[usize]) -> Option<&Node> {
        self.node(tid).filter(|node| node.path == path)
    }

    /// The node to report for a pick: the element itself when an address can
    /// name it, else its nearest ancestor that can.
    pub fn addressable(&self, tid: usize) -> Option<&Node> {
        let node = self.node(tid)?;
        let fits = |path: &[usize]| {
            path.len() <= MAX_ADDRESS_DEPTH && path.iter().all(|&index| index <= MAX_ADDRESS_INDEX)
        };
        if fits(&node.path) {
            return Some(node);
        }
        // Ancestors are the nodes whose path is a prefix of this one.
        let mut prefix = node.path.clone();
        while !prefix.is_empty() {
            prefix.pop();
            if fits(&prefix) {
                return self.nodes.iter().find(|candidate| candidate.path == prefix);
            }
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HtmlError {
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for HtmlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

fn line_of(source: &str, offset: usize) -> usize {
    source[..offset.min(source.len())]
        .bytes()
        .filter(|&b| b == b'\n')
        .count()
        + 1
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|dec| dec.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

struct Open {
    tag: String,
    node: usize,
    children: usize,
    foreign: bool,
}

/// Read a fragment strictly. Errors name the line and what is wrong, in
/// words the agent can act on.
pub fn parse(source: &str) -> Result<Parsed, HtmlError> {
    let bytes = source.as_bytes();
    let err = |offset: usize, message: String| HtmlError {
        line: line_of(source, offset),
        message,
    };
    let mut parsed = Parsed::default();
    let mut stack: Vec<Open> = Vec::new();
    let mut top_children = 0usize;
    let mut i = 0usize;
    let mut text_start = 0usize;
    let flush_text = |parsed: &mut Parsed, stack: &[Open], from: usize, to: usize| {
        if from >= to {
            return;
        }
        let text = decode_entities(&source[from..to]);
        for open in stack {
            let node = &mut parsed.nodes[open.node];
            if node.text.chars().count() < LABEL_CHARS * 4 {
                node.text.push_str(&text);
                node.text.push(' ');
            }
        }
    };
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // Comments.
        if source[i..].starts_with("<!--") {
            flush_text(&mut parsed, &stack, text_start, i);
            let end = source[i + 4..]
                .find("-->")
                .ok_or_else(|| err(i, "a comment is not closed with -->".into()))?;
            i = i + 4 + end + 3;
            text_start = i;
            continue;
        }
        if source[i..].starts_with("<!") || source[i..].starts_with("<?") {
            return Err(err(
                i,
                "an artboard is an HTML fragment: no <!doctype> or other declarations".into(),
            ));
        }
        // End tags.
        if source[i..].starts_with("</") {
            flush_text(&mut parsed, &stack, text_start, i);
            let name_start = i + 2;
            let name_len = source[name_start..]
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b':')
                .count();
            let name = source[name_start..name_start + name_len].to_ascii_lowercase();
            let close = source[name_start + name_len..]
                .find('>')
                .ok_or_else(|| err(i, format!("</{name} is not closed with >")))?;
            match stack.pop() {
                Some(open) if open.tag == name => {}
                Some(open) => {
                    return Err(err(
                        i,
                        format!(
                        "</{name}> closes <{}>, which is still open; close every element in order",
                        open.tag
                    ),
                    ))
                }
                None => return Err(err(i, format!("</{name}> has no matching start tag"))),
            }
            i = name_start + name_len + close + 1;
            text_start = i;
            continue;
        }
        // Start tags; a `<` not followed by a letter is text.
        let name_start = i + 1;
        if !bytes
            .get(name_start)
            .is_some_and(|b| b.is_ascii_alphabetic())
        {
            i += 1;
            continue;
        }
        flush_text(&mut parsed, &stack, text_start, i);
        let name_len = source[name_start..]
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b':')
            .count();
        let tag = source[name_start..name_start + name_len].to_ascii_lowercase();
        let name_end = name_start + name_len;
        if parsed.nodes.len() >= MAX_NODES {
            return Err(err(i, format!("more than {MAX_NODES} elements")));
        }
        // Attributes.
        let mut j = name_end;
        let mut self_closing = false;
        let mut mc_id = None;
        let mut alt = None;
        let mut seen = HashSet::new();
        loop {
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            match bytes.get(j) {
                None => return Err(err(i, format!("<{tag} is not closed with >"))),
                Some(b'>') => {
                    j += 1;
                    break;
                }
                Some(b'/') if bytes.get(j + 1) == Some(&b'>') => {
                    self_closing = true;
                    j += 2;
                    break;
                }
                _ => {}
            }
            let attr_start = j;
            let ends_name = |j: usize| {
                j >= bytes.len()
                    || bytes[j].is_ascii_whitespace()
                    || matches!(bytes[j], b'=' | b'>' | b'"' | b'\'' | b'<')
                    || (bytes[j] == b'/' && bytes.get(j + 1) == Some(&b'>'))
            };
            while !ends_name(j) {
                j += 1;
            }
            if j == attr_start {
                return Err(err(j, format!("unexpected character in <{tag}>")));
            }
            let attr = source[attr_start..j].to_ascii_lowercase();
            if !seen.insert(attr.clone()) {
                return Err(err(
                    attr_start,
                    format!("<{tag}> repeats the attribute {attr}"),
                ));
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let mut value = None;
            if bytes.get(j) == Some(&b'=') {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                let quote = match bytes.get(j) {
                    Some(q @ (b'"' | b'\'')) => *q,
                    _ => return Err(err(j, format!("<{tag}> {attr}= needs a quoted value"))),
                };
                let value_start = j + 1;
                let len = source[value_start..]
                    .bytes()
                    .position(|b| b == quote)
                    .ok_or_else(|| err(j, format!("<{tag}> {attr}= value is not closed")))?;
                value = Some((value_start, value_start + len));
                j = value_start + len + 1;
            }
            if attr == NODE_ATTRIBUTE {
                parsed.reserved_attribute = true;
            }
            if let Some((start, end)) = value {
                let raw = &source[start..end];
                match attr.as_str() {
                    ID_ATTRIBUTE => mc_id = Some(raw.to_string()),
                    "alt" => alt = Some(decode_entities(raw)),
                    "src" | "poster" | "href" => {
                        if let Some(id) = raw.trim().strip_prefix(ASSET_PREFIX) {
                            parsed.assets.push(AssetRef {
                                start,
                                end,
                                asset_id: id.trim().to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        // Number and place the element.
        let tid = parsed.nodes.len();
        let index = match stack.last_mut() {
            Some(parent) => {
                parent.children += 1;
                parent.children - 1
            }
            None => {
                top_children += 1;
                top_children - 1
            }
        };
        let mut node_path = stack
            .last()
            .map(|parent| parsed.nodes[parent.node].path.clone())
            .unwrap_or_default();
        node_path.push(index);
        parsed.nodes.push(Node {
            tid,
            path: node_path,
            tag: tag.clone(),
            mc_id,
            alt,
            text: String::new(),
            name_end,
        });
        let foreign =
            stack.last().is_some_and(|open| open.foreign) || tag == "svg" || tag == "math";
        i = j;
        text_start = i;
        if VOID.contains(&tag.as_str()) {
            continue;
        }
        if self_closing {
            if foreign {
                continue;
            }
            return Err(err(
                name_start,
                format!("<{tag} /> is not a void element; write <{tag}></{tag}>"),
            ));
        }
        if RAW_TEXT.contains(&tag.as_str()) {
            let lower = source[i..].to_ascii_lowercase();
            let close = lower
                .find(&format!("</{tag}"))
                .ok_or_else(|| err(name_start, format!("<{tag}> is not closed")))?;
            let content = &source[i..i + close];
            if tag == "script" {
                parsed.scripts.push(content.to_string());
            } else if tag == "textarea" || tag == "title" {
                parsed.nodes[tid].text.push_str(&decode_entities(content));
            }
            let after = i + close + 2 + tag.len();
            let gt = source[after..]
                .find('>')
                .ok_or_else(|| err(after, format!("</{tag} is not closed with >")))?;
            i = after + gt + 1;
            text_start = i;
            continue;
        }
        stack.push(Open {
            tag,
            node: tid,
            children: 0,
            foreign,
        });
    }
    flush_text(&mut parsed, &stack, text_start, bytes.len());
    if let Some(open) = stack.last() {
        let at = parsed.nodes[open.node].name_end;
        return Err(err(at, format!("<{}> is never closed", open.tag)));
    }
    Ok(parsed)
}

/// What a write must satisfy, and advice it may ignore.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Checked {
    pub warnings: Vec<String>,
}

/// The artboard conventions (docs/mc-agent/creative-canvas.md, 关键设计 2).
/// Structure only; whether the design is good is not this check's business.
pub fn check(source: &str) -> Result<(Parsed, Checked), String> {
    if source.len() > MAX_BOARD_BYTES {
        return Err(format!(
            "the artboard is {} KB; keep it under {} KB",
            source.len() / 1024,
            MAX_BOARD_BYTES / 1024
        ));
    }
    if source.trim().is_empty() {
        return Err("the artboard is empty".into());
    }
    let parsed = parse(source).map_err(|error| error.to_string())?;
    if let Some(node) = parsed
        .nodes
        .iter()
        .find(|node| FORBIDDEN.contains(&node.tag.as_str()))
    {
        return Err(format!(
            "<{}> is not allowed in an artboard (it is an HTML fragment shown in a sandbox: no document tags, frames, embeds, <base>, <meta> or <link>)",
            node.tag
        ));
    }
    if parsed.reserved_attribute {
        return Err(format!("{NODE_ATTRIBUTE} is set by the app; remove it"));
    }
    let mut ids = HashSet::new();
    for node in &parsed.nodes {
        if let Some(id) = &node.mc_id {
            let valid = !id.is_empty()
                && id.len() <= 40
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            if !valid {
                return Err(format!(
                    "{ID_ATTRIBUTE}=\"{id}\": use 1 to 40 letters, digits, - or _"
                ));
            }
            if !ids.insert(id.clone()) {
                return Err(format!(
                    "{ID_ATTRIBUTE}=\"{id}\" is used twice in this artboard"
                ));
            }
        }
    }
    let mut checked = Checked::default();
    let builds_ui = [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "appendChild",
        "document.write",
        "createElement",
    ];
    if parsed
        .scripts
        .iter()
        .any(|script| builds_ui.iter().any(|call| script.contains(call)))
    {
        checked.warnings.push(
            "a script builds elements at run time; write the elements as markup so they can be selected and commented on, and keep scripts for interaction state".into(),
        );
    }
    if ids.is_empty() && parsed.nodes.len() > 12 {
        checked.warnings.push(format!(
            "no element has {ID_ATTRIBUTE}; add short ids to key elements (buttons, cards, sections) so comments stay attached when you revise the artboard"
        ));
    }
    Ok((parsed, checked))
}

/// The source as served: each start tag numbered, and each `asset:` value
/// replaced by `asset_url` (or left empty when the asset is not available).
pub fn annotate(
    source: &str,
    parsed: &Parsed,
    asset_url: impl Fn(&str) -> Option<String>,
) -> String {
    enum Edit<'a> {
        Insert(usize, String),
        Replace(usize, usize, &'a str),
    }
    let mut edits: Vec<(usize, Edit<'_>)> = parsed
        .nodes
        .iter()
        .map(|node| {
            (
                node.name_end,
                Edit::Insert(node.name_end, format!(" {NODE_ATTRIBUTE}=\"{}\"", node.tid)),
            )
        })
        .collect();
    let urls: Vec<(usize, usize, String)> = parsed
        .assets
        .iter()
        .map(|asset| {
            (
                asset.start,
                asset.end,
                asset_url(&asset.asset_id).unwrap_or_default(),
            )
        })
        .collect();
    for (start, end, url) in &urls {
        edits.push((*start, Edit::Replace(*start, *end, url.as_str())));
    }
    edits.sort_by_key(|(at, _)| *at);
    let mut out = String::with_capacity(source.len() + parsed.nodes.len() * 20);
    let mut cursor = 0;
    for (_, edit) in edits {
        match edit {
            Edit::Insert(at, text) => {
                out.push_str(&source[cursor..at]);
                out.push_str(&text);
                cursor = at;
            }
            Edit::Replace(start, end, text) => {
                out.push_str(&source[cursor..start]);
                // Only safe URL characters reach the attribute.
                out.push_str(&text.replace(['"', '\'', '<', '>'], ""));
                cursor = end;
            }
        }
    }
    out.push_str(&source[cursor..]);
    out
}

/// Parse `<tid>:<path>` (the part of an address after `#`).
pub fn parse_address(raw: &str) -> Option<(usize, Vec<usize>)> {
    let (tid, path) = raw.split_once(':')?;
    let tid = tid.parse().ok()?;
    let path = path
        .split('/')
        .map(|segment| segment.parse().ok())
        .collect::<Option<Vec<usize>>>()?;
    (!path.is_empty()).then_some((tid, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"<style>body{margin:0}</style>
<div style="padding: 32px">
  <h1>Hello &amp; welcome</h1>
  <ul><li>One</li><li data-mc-id="two">Two</li></ul>
  <img src="asset:abc" alt="Hero image">
</div>"#;

    #[test]
    fn numbers_elements_in_document_order_with_paths() {
        let parsed = parse(MINIMAL).unwrap();
        let tags: Vec<_> = parsed.nodes.iter().map(|node| node.tag.as_str()).collect();
        assert_eq!(tags, ["style", "div", "h1", "ul", "li", "li", "img"]);
        let paths: Vec<_> = parsed.nodes.iter().map(Node::path_string).collect();
        assert_eq!(paths, ["0", "1", "1/0", "1/1", "1/1/0", "1/1/1", "1/2"]);
        assert_eq!(
            parsed.node(2).unwrap().label().as_deref(),
            Some("Hello & welcome")
        );
        assert_eq!(parsed.node(1).unwrap().kind(), "text");
        assert_eq!(
            parsed.node(6).unwrap().label().as_deref(),
            Some("Hero image")
        );
        assert_eq!(parsed.node(6).unwrap().kind(), "image");
        assert_eq!(parsed.by_mc_id("two").unwrap().tid, 5);
        assert!(parsed.by_address(5, &[1, 1, 1]).is_some());
        assert!(parsed.by_address(5, &[1, 1, 0]).is_none());
        // Style text never becomes a label.
        assert_eq!(parsed.node(0).unwrap().label(), None);
    }

    #[test]
    fn annotation_numbers_every_start_tag_and_resolves_assets() {
        let parsed = parse(MINIMAL).unwrap();
        let served = annotate(MINIMAL, &parsed, |id| {
            (id == "abc").then(|| "mc-canvas://asset/g/abc".to_string())
        });
        assert!(served.starts_with(r#"<style data-mc-node="0">"#));
        assert!(served.contains(r#"<li data-mc-node="5" data-mc-id="two">"#));
        assert!(served.contains(r#"<img data-mc-node="6" src="mc-canvas://asset/g/abc""#));
        // Serving again from the served text would find the reserved attribute.
        assert!(check(&served).unwrap_err().contains(NODE_ATTRIBUTE));
        // An asset that is not available becomes an empty source.
        let missing = annotate(MINIMAL, &parsed, |_| None);
        assert!(missing.contains(r#"src="""#));
    }

    #[test]
    fn strict_reading_names_the_problem() {
        let cases = [
            ("<div><span></div>", "closes <span>"),
            ("<div>", "never closed"),
            ("<div class=big></div>", "quoted value"),
            ("<!doctype html><div></div>", "fragment"),
            ("<div/>", "not a void element"),
            ("</p>", "no matching start tag"),
            ("<div a=\"1\" a=\"2\"></div>", "repeats"),
        ];
        for (source, expected) in cases {
            let error = parse(source).unwrap_err().to_string();
            assert!(error.contains(expected), "{source}: {error}");
        }
        // Text with a lone `<`, void tags, svg self-closing and raw text are fine.
        let ok = r#"<p>1 < 2<br></p><svg><path d="M0 0"/></svg><script>if (a < b && c) {}</script><input disabled>"#;
        let parsed = parse(ok).unwrap();
        assert_eq!(parsed.nodes.len(), 6);
    }

    #[test]
    fn conventions_refuse_frames_document_tags_and_duplicate_ids() {
        assert!(check("<iframe src=\"x\"></iframe>")
            .unwrap_err()
            .contains("<iframe>"));
        assert!(check("<html><body></body></html>")
            .unwrap_err()
            .contains("<html>"));
        assert!(check("<meta charset=\"utf-8\">")
            .unwrap_err()
            .contains("<meta>"));
        assert!(check(r#"<a data-mc-id="x"></a><b data-mc-id="x"></b>"#)
            .unwrap_err()
            .contains("twice"));
        assert!(check(r#"<a data-mc-id="no spaces"></a>"#).is_err());
        assert!(check("   ").is_err());
        let big = format!("<p>{}</p>", "a".repeat(MAX_BOARD_BYTES));
        assert!(check(&big).unwrap_err().contains("KB"));
        let (_, checked) =
            check("<div id=\"x\"></div><script>x.innerHTML = '<b>'</script>").unwrap();
        assert_eq!(checked.warnings.len(), 1);
    }

    #[test]
    fn deep_picks_fall_back_to_an_addressable_ancestor() {
        let mut source = String::new();
        for _ in 0..12 {
            source.push_str("<div>");
        }
        source.push_str("deep");
        for _ in 0..12 {
            source.push_str("</div>");
        }
        let parsed = parse(&source).unwrap();
        let picked = parsed.addressable(11).unwrap();
        assert_eq!(picked.path.len(), MAX_ADDRESS_DEPTH);
        assert_eq!(parse_address("5:1/1/1"), Some((5, vec![1, 1, 1])));
        assert_eq!(parse_address("5:"), None);
        assert_eq!(parse_address("x:1"), None);
    }
}
