package d1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dlclark/regexp2"
)

// A small byte-level BPE tokenizer.json with the d1/Compass split pattern.
func writeTokenizer(t *testing.T, ignoreMerges bool) string {
	t.Helper()
	enc := bytesToUnicode()
	vocab := map[string]int{}
	for b := 0; b < 256; b++ {
		vocab[enc[b]] = b
	}
	vocab["ab"], vocab["abc"], vocab["Ġx"] = 256, 257, 258
	tok := map[string]any{
		"added_tokens": []map[string]any{{"id": 300, "content": "<|im_end|>", "special": true}, {"id": 301, "content": "<think>", "special": false}},
		"pre_tokenizer": map[string]any{"type": "Sequence", "pretokenizers": []map[string]any{
			{"type": "Split", "pattern": map[string]string{"Regex": `(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`}},
			{"type": "ByteLevel"}}},
		// "abc" can only be reached by ignore_merges: no merge builds it.
		"model": map[string]any{"type": "BPE", "vocab": vocab, "merges": [][]string{{"a", "b"}}, "ignore_merges": ignoreMerges},
	}
	data, _ := json.Marshal(tok)
	path := filepath.Join(t.TempDir(), "tokenizer.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTokenizerHasNoMatchTimeout(t *testing.T) {
	tok, err := LoadTokenizer(writeTokenizer(t, false))
	if err != nil {
		t.Fatal(err)
	}
	// regexp2 treats 0 as an immediate deadline: matches then fail at random.
	if tok.split.MatchTimeout != regexp2.DefaultMatchTimeout {
		t.Fatalf("MatchTimeout = %v", tok.split.MatchTimeout)
	}
}

func TestTokenizerIgnoreMerges(t *testing.T) {
	plain, err := LoadTokenizer(writeTokenizer(t, false))
	if err != nil {
		t.Fatal(err)
	}
	ignoring, err := LoadTokenizer(writeTokenizer(t, true))
	if err != nil {
		t.Fatal(err)
	}
	if got := plain.Encode("abc"); len(got) != 2 || got[0] != 256 || got[1] != int('c') {
		t.Errorf("merges only: %v", got)
	}
	if got := ignoring.Encode("abc"); len(got) != 1 || got[0] != 257 {
		t.Errorf("ignore_merges: %v", got)
	}
	if got := ignoring.Encode("x<|im_end|><think>"); len(got) != 3 || got[1] != 300 || got[2] != 301 {
		t.Errorf("added tokens: %v", got)
	}
	if got := ignoring.AddedTokens(); len(got) != 2 || got[0] != "<|im_end|>" || got[1] != "<think>" {
		t.Errorf("added token order: %v", got)
	}
}
