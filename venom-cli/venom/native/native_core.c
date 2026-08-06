/**
 * VENOM CLI — Native Core (C / N-API)
 *
 * Performance-critical functions compiled as a native Node.js addon:
 *   - Ultra-fast string cleaning (strip ANSI, normalize whitespace)
 *   - Token boundary detection for prompt optimization
 *   - Fast code block extraction from LLM output
 *
 * Compiled via node-gyp using N-API (version 8) for ABI stability.
 */

#include <node_api.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* =========================================================================
 * Utility: Safe N-API macros
 * ========================================================================= */

#define NAPI_CALL(env, call)                                                    \
  do {                                                                          \
    napi_status status = (call);                                                \
    if (status != napi_ok) {                                                    \
      const napi_extended_error_info *error_info = NULL;                        \
      napi_get_last_error_info((env), &error_info);                             \
      const char *msg = (error_info && error_info->error_message)               \
                            ? error_info->error_message                         \
                            : "Unknown N-API error";                            \
      napi_throw_error((env), NULL, msg);                                       \
      return NULL;                                                              \
    }                                                                           \
  } while (0)

/* =========================================================================
 * strip_ansi(input: string): string
 *
 * Removes all ANSI escape sequences (\x1b[...m, \x1b[...H, etc.)
 * from the input string. O(n) single-pass.
 * ========================================================================= */

static char *strip_ansi_codes(const char *src, size_t src_len, size_t *out_len) {
  /* Worst case: output is same size as input */
  char *out = (char *)malloc(src_len + 1);
  if (!out) return NULL;

  size_t j = 0;
  size_t i = 0;

  while (i < src_len) {
    if (src[i] == '\x1b' && (i + 1) < src_len && src[i + 1] == '[') {
      /* Skip ESC [ ... until we hit a letter (the terminator) */
      i += 2;
      while (i < src_len && !((src[i] >= 'A' && src[i] <= 'Z') ||
                               (src[i] >= 'a' && src[i] <= 'z'))) {
        i++;
      }
      if (i < src_len) i++; /* skip the terminator letter */
    } else {
      out[j++] = src[i++];
    }
  }

  out[j] = '\0';
  *out_len = j;
  return out;
}

static napi_value fn_strip_ansi(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_error(env, NULL, "strip_ansi requires 1 argument (string)");
    return NULL;
  }

  /* Get input string */
  size_t str_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &str_len));

  char *input = (char *)malloc(str_len + 1);
  if (!input) {
    napi_throw_error(env, NULL, "Memory allocation failed");
    return NULL;
  }

  size_t copied;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], input, str_len + 1, &copied));

  /* Process */
  size_t out_len;
  char *result = strip_ansi_codes(input, copied, &out_len);
  free(input);

  if (!result) {
    napi_throw_error(env, NULL, "strip_ansi: processing failed");
    return NULL;
  }

  napi_value output;
  NAPI_CALL(env, napi_create_string_utf8(env, result, out_len, &output));
  free(result);

  return output;
}

/* =========================================================================
 * normalize_whitespace(input: string): string
 *
 * Collapses consecutive whitespace characters into single spaces and
 * trims leading/trailing whitespace. O(n) single-pass.
 * ========================================================================= */

static char *normalize_ws(const char *src, size_t src_len, size_t *out_len) {
  char *out = (char *)malloc(src_len + 1);
  if (!out) return NULL;

  size_t j = 0;
  int in_space = 1; /* treat start as whitespace to trim leading */

  for (size_t i = 0; i < src_len; i++) {
    if (isspace((unsigned char)src[i])) {
      if (!in_space && j > 0) {
        out[j++] = ' ';
        in_space = 1;
      }
    } else {
      out[j++] = src[i];
      in_space = 0;
    }
  }

  /* Trim trailing space */
  if (j > 0 && out[j - 1] == ' ') {
    j--;
  }

  out[j] = '\0';
  *out_len = j;
  return out;
}

static napi_value fn_normalize_whitespace(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_error(env, NULL, "normalize_whitespace requires 1 argument");
    return NULL;
  }

  size_t str_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &str_len));

  char *input = (char *)malloc(str_len + 1);
  if (!input) {
    napi_throw_error(env, NULL, "Memory allocation failed");
    return NULL;
  }

  size_t copied;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], input, str_len + 1, &copied));

  size_t out_len;
  char *result = normalize_ws(input, copied, &out_len);
  free(input);

  if (!result) {
    napi_throw_error(env, NULL, "normalize_whitespace: processing failed");
    return NULL;
  }

  napi_value output;
  NAPI_CALL(env, napi_create_string_utf8(env, result, out_len, &output));
  free(result);

  return output;
}

/* =========================================================================
 * count_tokens_approx(input: string): number
 *
 * Fast approximate token count using whitespace + punctuation boundaries.
 * This is NOT a proper BPE tokenizer — it's a fast heuristic for prompt
 * size estimation (roughly 1 token per 4 chars or per word boundary).
 * ========================================================================= */

static napi_value fn_count_tokens_approx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_error(env, NULL, "count_tokens_approx requires 1 argument");
    return NULL;
  }

  size_t str_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &str_len));

  char *input = (char *)malloc(str_len + 1);
  if (!input) {
    napi_throw_error(env, NULL, "Memory allocation failed");
    return NULL;
  }

  size_t copied;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], input, str_len + 1, &copied));

  /* Count boundaries: transitions between word chars and non-word chars */
  uint32_t tokens = 0;
  int in_word = 0;

  for (size_t i = 0; i < copied; i++) {
    unsigned char c = (unsigned char)input[i];
    int is_word_char = isalnum(c) || c == '_';

    if (is_word_char && !in_word) {
      tokens++;
      in_word = 1;
    } else if (!is_word_char) {
      if (!isspace(c)) {
        tokens++; /* punctuation counts as a token */
      }
      in_word = 0;
    }
  }

  free(input);

  napi_value result;
  NAPI_CALL(env, napi_create_uint32(env, tokens, &result));
  return result;
}

/* =========================================================================
 * extract_code_blocks(input: string): string[]
 *
 * Fast extraction of fenced code block contents (``` ... ```) from LLM
 * output. Returns an array of strings (the content between fences).
 * ========================================================================= */

static napi_value fn_extract_code_blocks(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_error(env, NULL, "extract_code_blocks requires 1 argument");
    return NULL;
  }

  size_t str_len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &str_len));

  char *input = (char *)malloc(str_len + 1);
  if (!input) {
    napi_throw_error(env, NULL, "Memory allocation failed");
    return NULL;
  }

  size_t copied;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], input, str_len + 1, &copied));

  /* Create result array */
  napi_value result_array;
  NAPI_CALL(env, napi_create_array(env, &result_array));

  uint32_t block_count = 0;
  const char *fence = "```";
  size_t fence_len = 3;
  size_t i = 0;

  while (i + fence_len <= copied) {
    /* Find opening fence */
    if (strncmp(input + i, fence, fence_len) == 0) {
      /* Skip to end of line (past language specifier) */
      size_t start = i + fence_len;
      while (start < copied && input[start] != '\n') {
        start++;
      }
      if (start < copied) start++; /* skip the newline */

      /* Find closing fence */
      size_t end = start;
      int found_close = 0;
      while (end + fence_len <= copied) {
        if (input[end] == '`' && strncmp(input + end, fence, fence_len) == 0) {
          found_close = 1;
          break;
        }
        end++;
      }

      if (found_close && end > start) {
        /* Extract block content */
        size_t block_len = end - start;
        napi_value block_str;
        NAPI_CALL(env, napi_create_string_utf8(env, input + start, block_len, &block_str));
        NAPI_CALL(env, napi_set_element(env, result_array, block_count, block_str));
        block_count++;

        i = end + fence_len;
        /* Skip rest of closing fence line */
        while (i < copied && input[i] != '\n') i++;
        if (i < copied) i++;
        continue;
      }
    }

    i++;
  }

  free(input);
  return result_array;
}

/* =========================================================================
 * Module Initialization
 * ========================================================================= */

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"stripAnsi", NULL, fn_strip_ansi, NULL, NULL, NULL, napi_default, NULL},
    {"normalizeWhitespace", NULL, fn_normalize_whitespace, NULL, NULL, NULL, napi_default, NULL},
    {"countTokensApprox", NULL, fn_count_tokens_approx, NULL, NULL, NULL, napi_default, NULL},
    {"extractCodeBlocks", NULL, fn_extract_code_blocks, NULL, NULL, NULL, napi_default, NULL},
  };

  NAPI_CALL(env, napi_define_properties(
    env, exports,
    sizeof(descriptors) / sizeof(descriptors[0]),
    descriptors
  ));

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
