/**
 * VENOM CLI — Native Core (C / N-API)
 * (Moved to top-level native/)
 * Same functions: stripAnsi, normalizeWhitespace, countTokensApprox, extractCodeBlocks
 */

#include <node_api.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

#define NAPI_CALL(env, call) \
  do { napi_status s = (call); if (s != napi_ok) { \
    const napi_extended_error_info *ei = NULL; napi_get_last_error_info((env), &ei); \
    napi_throw_error((env), NULL, (ei && ei->error_message) ? ei->error_message : "N-API error"); \
    return NULL; } } while (0)

/* --- strip_ansi --- */
static char *strip_ansi(const char *src, size_t len, size_t *out) {
  char *o = (char *)malloc(len + 1);
  if (!o) return NULL;
  size_t j = 0, i = 0;
  while (i < len) {
    if (src[i] == '\x1b' && i + 1 < len && src[i + 1] == '[') {
      i += 2;
      while (i < len && !((src[i] >= 'A' && src[i] <= 'Z') || (src[i] >= 'a' && src[i] <= 'z'))) i++;
      if (i < len) i++;
    } else { o[j++] = src[i++]; }
  }
  o[j] = '\0'; *out = j; return o;
}

static napi_value fn_strip_ansi(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) { napi_throw_error(env, NULL, "1 arg required"); return NULL; }
  size_t len; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));
  char *in = (char *)malloc(len + 1); if (!in) { napi_throw_error(env, NULL, "OOM"); return NULL; }
  size_t cp; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], in, len + 1, &cp));
  size_t ol; char *r = strip_ansi(in, cp, &ol); free(in);
  if (!r) { napi_throw_error(env, NULL, "strip failed"); return NULL; }
  napi_value out; NAPI_CALL(env, napi_create_string_utf8(env, r, ol, &out)); free(r); return out;
}

/* --- normalize_whitespace --- */
static char *norm_ws(const char *src, size_t len, size_t *out) {
  char *o = (char *)malloc(len + 1); if (!o) return NULL;
  size_t j = 0; int sp = 1;
  for (size_t i = 0; i < len; i++) {
    if (isspace((unsigned char)src[i])) { if (!sp && j > 0) { o[j++] = ' '; sp = 1; } }
    else { o[j++] = src[i]; sp = 0; }
  }
  if (j > 0 && o[j - 1] == ' ') j--;
  o[j] = '\0'; *out = j; return o;
}

static napi_value fn_norm_ws(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) { napi_throw_error(env, NULL, "1 arg required"); return NULL; }
  size_t len; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));
  char *in = (char *)malloc(len + 1); if (!in) { napi_throw_error(env, NULL, "OOM"); return NULL; }
  size_t cp; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], in, len + 1, &cp));
  size_t ol; char *r = norm_ws(in, cp, &ol); free(in);
  if (!r) { napi_throw_error(env, NULL, "norm failed"); return NULL; }
  napi_value out; NAPI_CALL(env, napi_create_string_utf8(env, r, ol, &out)); free(r); return out;
}

/* --- count_tokens_approx --- */
static napi_value fn_count_tokens(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) { napi_throw_error(env, NULL, "1 arg required"); return NULL; }
  size_t len; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));
  char *in = (char *)malloc(len + 1); if (!in) { napi_throw_error(env, NULL, "OOM"); return NULL; }
  size_t cp; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], in, len + 1, &cp));
  uint32_t tok = 0; int iw = 0;
  for (size_t i = 0; i < cp; i++) {
    unsigned char c = (unsigned char)in[i];
    int wc = isalnum(c) || c == '_';
    if (wc && !iw) { tok++; iw = 1; }
    else if (!wc) { if (!isspace(c)) tok++; iw = 0; }
  }
  free(in);
  napi_value out; NAPI_CALL(env, napi_create_uint32(env, tok, &out)); return out;
}

/* --- extract_code_blocks --- */
static napi_value fn_extract_blocks(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) { napi_throw_error(env, NULL, "1 arg required"); return NULL; }
  size_t len; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));
  char *in = (char *)malloc(len + 1); if (!in) { napi_throw_error(env, NULL, "OOM"); return NULL; }
  size_t cp; NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], in, len + 1, &cp));

  napi_value arr; NAPI_CALL(env, napi_create_array(env, &arr));
  uint32_t cnt = 0; const char *fence = "```"; size_t fl = 3, i = 0;
  while (i + fl <= cp) {
    if (strncmp(in + i, fence, fl) == 0) {
      size_t s = i + fl;
      while (s < cp && in[s] != '\n') s++;
      if (s < cp) s++;
      size_t e = s; int found = 0;
      while (e + fl <= cp) { if (in[e] == '`' && strncmp(in + e, fence, fl) == 0) { found = 1; break; } e++; }
      if (found && e > s) {
        napi_value str; NAPI_CALL(env, napi_create_string_utf8(env, in + s, e - s, &str));
        NAPI_CALL(env, napi_set_element(env, arr, cnt++, str));
        i = e + fl; while (i < cp && in[i] != '\n') i++; if (i < cp) i++; continue;
      }
    }
    i++;
  }
  free(in); return arr;
}

/* --- Init --- */
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor d[] = {
    {"stripAnsi", NULL, fn_strip_ansi, NULL, NULL, NULL, napi_default, NULL},
    {"normalizeWhitespace", NULL, fn_norm_ws, NULL, NULL, NULL, napi_default, NULL},
    {"countTokensApprox", NULL, fn_count_tokens, NULL, NULL, NULL, napi_default, NULL},
    {"extractCodeBlocks", NULL, fn_extract_blocks, NULL, NULL, NULL, napi_default, NULL},
  };
  NAPI_CALL(env, napi_define_properties(env, exports, sizeof(d) / sizeof(d[0]), d));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
