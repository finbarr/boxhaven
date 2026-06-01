digitalocean_api_get_url() {
  local url="$1"
  case "$url" in
    http://*|https://*|file://*)
      curl -fsS -H "Authorization: Bearer ${token}" "$url"
      ;;
    *)
      curl -fsS -H "Authorization: Bearer ${token}" "${api_url}${url}"
      ;;
  esac
}

digitalocean_api_get_all() {
  local key="$1"
  local path="$2"
  local next="$path"
  local items="[]"
  local page page_items

  while [ -n "$next" ]; do
    page="$(digitalocean_api_get_url "$next")"
    page_items="$(printf '%s' "$page" | jq -c --arg key "$key" '.[$key] // []')"
    items="$(jq -cn --argjson left "$items" --argjson right "$page_items" '$left + $right')"
    next="$(printf '%s' "$page" | jq -r '.links.pages.next // empty')"
  done

  jq -cn --arg key "$key" --argjson items "$items" '{($key): $items}'
}
