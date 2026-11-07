package d1

// Port of the image processor in WebBrain's compass-vld-v6-runtime.js
// (Lfm3VlImageProcessor): smart_resize to multiples of 32 within the pixel
// budget, Pillow's integer BICUBIC resampling (compass-vld-runtime.js
// resizeBicubicRGB), the fused (x - 127.5) / 127.5 normalization and the
// vision encoder's patch order [gh/2, gw/2, 2, 2, 3*2*16*16].

import (
	"errors"
	"fmt"
	"math"
)

const (
	compassPatch     = 16
	compassMerge     = 2
	compassTemporal  = 2
	compassMinPixels = 65536    // processor_config.json size.shortest_edge
	compassMaxPixels = 16777216 // size.longest_edge
	compassHidden    = 2048
	compassPatchDim  = 3 * compassTemporal * compassPatch * compassPatch
)

// pyRound is the runtime's pyRound (Python's round: ties to even).
func pyRound(x float64) float64 {
	r := math.Floor(x + 0.5) // Math.round
	if math.Abs(math.Mod(x, 1)) == 0.5 {
		return 2 * math.Floor(x/2+0.5)
	}
	return r
}

// smartResize returns [height, width], both multiples of factor, within the pixel budget.
func smartResize(height, width, factor, minPixels, maxPixels int) (int, int, error) {
	h, w, f := float64(height), float64(width), float64(factor)
	if math.Max(h, w)/math.Min(h, w) > 200 {
		return 0, 0, fmt.Errorf("The image's aspect ratio must be under 200 (got %.1f).", math.Max(h, w)/math.Min(h, w))
	}
	hBar := pyRound(h/f) * f
	wBar := pyRound(w/f) * f
	if hBar*wBar > float64(maxPixels) {
		beta := math.Sqrt(h * w / float64(maxPixels))
		hBar = math.Max(f, math.Floor(h/beta/f)*f)
		wBar = math.Max(f, math.Floor(w/beta/f)*f)
	} else if hBar*wBar < float64(minPixels) {
		beta := math.Sqrt(float64(minPixels) / (h * w))
		hBar = math.Ceil(h*beta/f) * f
		wBar = math.Ceil(w*beta/f) * f
	}
	return int(hBar), int(wBar), nil
}

// Pillow's ImagingResample (BICUBIC, a = -0.5), 8-bit fixed point.
const pillowPrecisionBits = 32 - 8 - 2

func bicubicFilter(x float64) float64 {
	const a = -0.5
	x = math.Abs(x)
	if x < 1.0 {
		return ((a+2.0)*x-(a+3.0))*x*x + 1
	}
	if x < 2.0 {
		return (((x-5)*x+8)*x - 4) * a
	}
	return 0.0
}

type resampleCoeffs struct {
	ksize  int
	bounds []int // xmin, count per output pixel
	kint   []int64
}

func precomputeCoeffs(inSize, outSize int) resampleCoeffs {
	scale := float64(inSize) / float64(outSize)
	filterscale := math.Max(scale, 1.0)
	support := 2.0 * filterscale
	ksize := int(math.Ceil(support))*2 + 1
	bounds := make([]int, outSize*2)
	kk := make([]float64, outSize*ksize)
	ss := 1.0 / filterscale
	for xx := 0; xx < outSize; xx++ {
		center := (float64(xx) + 0.5) * scale
		ww := 0.0
		xmin := int(math.Trunc(center - support + 0.5))
		if xmin < 0 {
			xmin = 0
		}
		xmax := int(math.Trunc(center + support + 0.5))
		if xmax > inSize {
			xmax = inSize
		}
		xmax -= xmin
		base := xx * ksize
		for x := 0; x < xmax; x++ {
			w := bicubicFilter((float64(x+xmin) - center + 0.5) * ss)
			kk[base+x] = w
			ww += w
		}
		for x := 0; x < xmax; x++ {
			if ww != 0.0 {
				kk[base+x] /= ww
			}
		}
		bounds[xx*2] = xmin
		bounds[xx*2+1] = xmax
	}
	kint := make([]int64, len(kk))
	for i, k := range kk {
		v := k * (1 << pillowPrecisionBits)
		if v < 0 {
			kint[i] = int64(math.Trunc(-0.5 + v))
		} else {
			kint[i] = int64(math.Trunc(0.5 + v))
		}
	}
	return resampleCoeffs{ksize, bounds, kint}
}

func clipPillow(v int64) byte {
	r := v >> pillowPrecisionBits // floor division
	if r < 0 {
		return 0
	}
	if r > 255 {
		return 255
	}
	return byte(r)
}

// resizeBicubicRGB resizes interleaved RGB with Pillow's BICUBIC: horizontal
// pass, then vertical, each rounded to uint8.
func resizeBicubicRGB(src []byte, width, height, outW, outH int) []byte {
	const half = int64(1) << (pillowPrecisionBits - 1)
	cur, cw, ch := src, width, height
	if outW != cw {
		c := precomputeCoeffs(cw, outW)
		dst := make([]byte, outW*ch*3)
		for y := 0; y < ch; y++ {
			for xx := 0; xx < outW; xx++ {
				xmin, xmax, k := c.bounds[xx*2], c.bounds[xx*2+1], xx*c.ksize
				s0, s1, s2 := half, half, half
				for x := 0; x < xmax; x++ {
					p, w := (y*cw+x+xmin)*3, c.kint[k+x]
					s0 += int64(cur[p]) * w
					s1 += int64(cur[p+1]) * w
					s2 += int64(cur[p+2]) * w
				}
				o := (y*outW + xx) * 3
				dst[o], dst[o+1], dst[o+2] = clipPillow(s0), clipPillow(s1), clipPillow(s2)
			}
		}
		cur, cw = dst, outW
	}
	if outH != ch {
		c := precomputeCoeffs(ch, outH)
		dst := make([]byte, cw*outH*3)
		for yy := 0; yy < outH; yy++ {
			ymin, ymax, k := c.bounds[yy*2], c.bounds[yy*2+1], yy*c.ksize
			for x := 0; x < cw; x++ {
				s0, s1, s2 := half, half, half
				for y := 0; y < ymax; y++ {
					p, w := ((y+ymin)*cw+x)*3, c.kint[k+y]
					s0 += int64(cur[p]) * w
					s1 += int64(cur[p+1]) * w
					s2 += int64(cur[p+2]) * w
				}
				o := (yy*cw + x) * 3
				dst[o], dst[o+1], dst[o+2] = clipPillow(s0), clipPillow(s1), clipPillow(s2)
			}
		}
		cur = dst
	}
	return cur
}

// The processor fuses rescale (1/255) and normalize (mean = std = 0.5) into
// (x - 127.5) / 127.5 in float32.
var compassNorm = func() (t [256]float32) {
	for x := range t {
		t[x] = float32((float64(x) - 127.5) / 127.5)
	}
	return
}()

// compassImage is one preprocessed image.
type compassImage struct {
	Width  int `json:"width"` // after smart_resize
	Height int `json:"height"`
	GridH  int `json:"grid_h"` // patches
	GridW  int `json:"grid_w"`
	Tokens int `json:"tokens"` // image tokens in the prompt
	// Source size before resizing.
	SourceWidth  int `json:"source_width"`
	SourceHeight int `json:"source_height"`
	pixels       []float32
}

// preprocessCompass runs Lfm3VlImageProcessor on interleaved RGB pixels.
// maxPixels is the processor's budget (compassMaxPixels in the browser).
func preprocessCompass(rgb []byte, width, height, maxPixels int) (compassImage, error) {
	if width < 1 || height < 1 {
		return compassImage{}, errors.New("Empty image")
	}
	const P, M, T = compassPatch, compassMerge, compassTemporal
	rh, rw, err := smartResize(height, width, P*M, compassMinPixels, maxPixels)
	if err != nil {
		return compassImage{}, err
	}
	pixels8 := rgb
	if rw != width || rh != height {
		pixels8 = resizeBicubicRGB(rgb, width, height, rw, rh)
	}
	gh, gw := rh/P, rw/P
	const D = compassPatchDim
	out := make([]float32, gh*gw*D)
	bw := gw / M
	for by := 0; by < gh/M; by++ {
		for bx := 0; bx < bw; bx++ {
			for my := 0; my < M; my++ {
				for mx := 0; mx < M; mx++ {
					base := (((by*bw+bx)*M+my)*M + mx) * D
					y0, x0 := (by*M+my)*P, (bx*M+mx)*P
					for c := 0; c < 3; c++ {
						for py := 0; py < P; py++ {
							row := ((y0+py)*rw+x0)*3 + c
							for px := 0; px < P; px++ {
								v := compassNorm[pixels8[row+px*3]]
								// The frame is repeated for each temporal step.
								for t := 0; t < T; t++ {
									out[base+((c*T+t)*P+py)*P+px] = v
								}
							}
						}
					}
				}
			}
		}
	}
	return compassImage{Width: rw, Height: rh, GridH: gh, GridW: gw, Tokens: gh * gw / (M * M),
		SourceWidth: width, SourceHeight: height, pixels: out}, nil
}
