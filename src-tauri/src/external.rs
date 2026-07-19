const ALLOWED_EXTERNAL_PROTOCOLS: &[&str] = &["http", "https", "mailto"];

pub fn validate_external_url(raw_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw_url).map_err(|_| "Invalid external URL".to_string())?;
    if !ALLOWED_EXTERNAL_PROTOCOLS.contains(&parsed.scheme()) {
        return Err(format!(
            "External URL protocol is not allowed: {}",
            parsed.scheme()
        ));
    }
    Ok(())
}

pub fn open_external_url(raw_url: &str) -> Result<(), String> {
    validate_external_url(raw_url)?;
    open::that(raw_url).map_err(|e| format!("Failed to open external URL: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_web_and_mail_urls() {
        assert!(validate_external_url("https://example.com/docs").is_ok());
        assert!(validate_external_url("http://example.com").is_ok());
        assert!(validate_external_url("mailto:test@example.com").is_ok());
    }

    #[test]
    fn rejects_local_and_executable_urls() {
        assert!(validate_external_url("file:///tmp/note.md").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("tauri://localhost").is_err());
        assert!(validate_external_url("not a url").is_err());
    }
}
