{
  "targets": [
    {
      "target_name": "native_core",
      "sources": ["native/native_core.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-api-headers').include_dir\")"
      ],
      "defines": ["NAPI_VERSION=8"],
      "cflags": ["-std=c11", "-O3", "-Wall", "-Wextra"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "Optimization": 2, "RuntimeLibrary": 2 }
          }
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_OPTIMIZATION_LEVEL": "3",
            "CLANG_CXX_LANGUAGE_STANDARD": "c11"
          }
        }]
      ]
    }
  ]
}
