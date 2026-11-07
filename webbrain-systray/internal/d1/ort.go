package d1

// A minimal ONNX Runtime binding over the C API, loaded at runtime with
// purego (no cgo). Function pointers are read from the OrtApi table; the
// indices below come from onnxruntime_c_api.h (the table is append-only, so
// they are stable across ORT releases).

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

const ortRequestedAPIVersion = 20

const (
	fnGetErrorMessage                = 2
	fnCreateEnv                      = 3
	fnCreateSession                  = 7
	fnRun                            = 9
	fnCreateSessionOptions           = 10
	fnSetSessionGraphOptimization    = 23
	fnSetIntraOpNumThreads           = 24
	fnSetInterOpNumThreads           = 25
	fnSessionGetInputCount           = 30
	fnSessionGetOutputCount          = 31
	fnSessionGetInputName            = 36
	fnSessionGetOutputName           = 37
	fnCreateRunOptions               = 39
	fnRunOptionsSetTerminate         = 46
	fnCreateTensorWithDataAsOrtValue = 49
	fnGetTensorMutableData           = 51
	fnGetTensorElementType           = 60
	fnGetDimensionsCount             = 61
	fnGetDimensions                  = 62
	fnGetTensorShapeElementCount     = 64
	fnGetTensorTypeAndShape          = 65
	fnCreateCpuMemoryInfo            = 69
	fnAllocatorFree                  = 76
	fnGetAllocatorWithDefaultOptions = 78
	fnReleaseEnv                     = 92
	fnReleaseStatus                  = 93
	fnReleaseMemoryInfo              = 94
	fnReleaseSession                 = 95
	fnReleaseValue                   = 96
	fnReleaseRunOptions              = 97
	fnReleaseTensorTypeAndShapeInfo  = 99
	fnReleaseSessionOptions          = 100
)

// ONNX tensor element types.
const (
	elemFloat   = 1
	elemInt64   = 7
	elemBool    = 9
	elemFloat16 = 10
)

type ortLib struct {
	api     uintptr
	env     uintptr
	memInfo uintptr
	alloc   uintptr
	version string
}

// cptr turns an address owned by C into a pointer (C memory never moves).
func cptr(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func (o *ortLib) fn(idx int) uintptr {
	return *(*uintptr)(unsafe.Add(cptr(o.api), idx*int(unsafe.Sizeof(uintptr(0)))))
}

func (o *ortLib) call(idx int, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(o.fn(idx), args...)
	return r
}

// check converts an OrtStatus* into an error and releases it.
func (o *ortLib) check(status uintptr) error {
	if status == 0 {
		return nil
	}
	msg := goString(o.call(fnGetErrorMessage, status))
	o.call(fnReleaseStatus, status)
	return errors.New("onnxruntime: " + msg)
}

func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var b []byte
	for i := 0; i < 1<<16; i++ {
		c := *(*byte)(unsafe.Add(cptr(p), i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func cString(s string) []byte { return append([]byte(s), 0) }

// ortPath encodes a filesystem path as ORTCHAR_T* (UTF-16 on Windows).
func ortPath(p string) (uintptr, any) {
	if runtime.GOOS == "windows" {
		u := append(utf16.Encode([]rune(p)), 0)
		return uintptr(unsafe.Pointer(&u[0])), u
	}
	b := cString(p)
	return uintptr(unsafe.Pointer(&b[0])), b
}

var (
	ortOnce sync.Mutex
	ortInst *ortLib
)

// loadORT opens the ONNX Runtime shared library and creates the environment.
func loadORT(libPath string) (*ortLib, error) {
	ortOnce.Lock()
	defer ortOnce.Unlock()
	if ortInst != nil {
		return ortInst, nil
	}
	sym, err := openSymbol(libPath, "OrtGetApiBase")
	if err != nil {
		return nil, err
	}
	base, _, _ := purego.SyscallN(sym)
	if base == 0 {
		return nil, errors.New("OrtGetApiBase returned null")
	}
	getAPI := *(*uintptr)(cptr(base))
	getVersion := *(*uintptr)(unsafe.Add(cptr(base), unsafe.Sizeof(uintptr(0))))
	api, _, _ := purego.SyscallN(getAPI, ortRequestedAPIVersion)
	if api == 0 {
		return nil, fmt.Errorf("ONNX Runtime at %s does not support API version %d", libPath, ortRequestedAPIVersion)
	}
	vp, _, _ := purego.SyscallN(getVersion)
	o := &ortLib{api: api, version: goString(vp)}
	logid := cString("webbrain-d1")
	var env uintptr
	if err := o.check(o.call(fnCreateEnv, 3 /* ERROR */, uintptr(unsafe.Pointer(&logid[0])), uintptr(unsafe.Pointer(&env)))); err != nil {
		return nil, err
	}
	runtime.KeepAlive(logid)
	o.env = env
	var mi uintptr
	if err := o.check(o.call(fnCreateCpuMemoryInfo, 1 /* arena */, 0 /* default */, uintptr(unsafe.Pointer(&mi)))); err != nil {
		return nil, err
	}
	o.memInfo = mi
	var alloc uintptr
	if err := o.check(o.call(fnGetAllocatorWithDefaultOptions, uintptr(unsafe.Pointer(&alloc)))); err != nil {
		return nil, err
	}
	o.alloc = alloc
	ortInst = o
	return o, nil
}

type session struct {
	o       *ortLib
	ptr     uintptr
	inputs  []string
	outputs []string
}

// Graph optimization levels (GraphOptimizationLevel).
const (
	optExtended = 2  // ORT_ENABLE_EXTENDED: fusions without layout transforms
	optAll      = 99 // ORT_ENABLE_ALL
)

func (o *ortLib) newSession(modelPath string, threads int) (*session, error) {
	return o.newSessionLevel(modelPath, threads, optExtended)
}

func (o *ortLib) newSessionLevel(modelPath string, threads, level int) (*session, error) {
	var opts uintptr
	if err := o.check(o.call(fnCreateSessionOptions, uintptr(unsafe.Pointer(&opts)))); err != nil {
		return nil, err
	}
	defer o.call(fnReleaseSessionOptions, opts)
	if threads > 0 {
		if err := o.check(o.call(fnSetIntraOpNumThreads, opts, uintptr(threads))); err != nil {
			return nil, err
		}
	}
	if err := o.check(o.call(fnSetInterOpNumThreads, opts, 1)); err != nil {
		return nil, err
	}
	if err := o.check(o.call(fnSetSessionGraphOptimization, opts, uintptr(level))); err != nil {
		return nil, err
	}
	p, keep := ortPath(modelPath)
	var s uintptr
	err := o.check(o.call(fnCreateSession, o.env, p, opts, uintptr(unsafe.Pointer(&s))))
	runtime.KeepAlive(keep)
	if err != nil {
		return nil, err
	}
	sess := &session{o: o, ptr: s}
	var n uintptr
	if err := o.check(o.call(fnSessionGetInputCount, s, uintptr(unsafe.Pointer(&n)))); err != nil {
		return nil, err
	}
	for i := uintptr(0); i < n; i++ {
		var name uintptr
		if err := o.check(o.call(fnSessionGetInputName, s, i, o.alloc, uintptr(unsafe.Pointer(&name)))); err != nil {
			return nil, err
		}
		sess.inputs = append(sess.inputs, goString(name))
		o.call(fnAllocatorFree, o.alloc, name)
	}
	if err := o.check(o.call(fnSessionGetOutputCount, s, uintptr(unsafe.Pointer(&n)))); err != nil {
		return nil, err
	}
	for i := uintptr(0); i < n; i++ {
		var name uintptr
		if err := o.check(o.call(fnSessionGetOutputName, s, i, o.alloc, uintptr(unsafe.Pointer(&name)))); err != nil {
			return nil, err
		}
		sess.outputs = append(sess.outputs, goString(name))
		o.call(fnAllocatorFree, o.alloc, name)
	}
	return sess, nil
}

func (s *session) release() {
	if s != nil && s.ptr != 0 {
		s.o.call(fnReleaseSession, s.ptr)
		s.ptr = 0
	}
}

// tensor is an input whose bytes stay owned by Go until the run returns.
type tensor struct {
	elem  int
	shape []int64
	data  unsafe.Pointer
	bytes uintptr
	keep  any
}

func floatTensor(data []float32, shape ...int64) tensor {
	var dummy [1]float32
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemFloat, shape, p, uintptr(len(data) * 4), [2]any{data, &dummy}}
}

func int64Tensor(data []int64, shape ...int64) tensor {
	var dummy [1]int64
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemInt64, shape, p, uintptr(len(data) * 8), [2]any{data, &dummy}}
}

func boolTensor(data []bool, shape ...int64) tensor {
	var dummy [1]bool
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemBool, shape, p, uintptr(len(data)), [2]any{data, &dummy}}
}

func float16Tensor(data []uint16, shape ...int64) tensor {
	var dummy [1]uint16
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemFloat16, shape, p, uintptr(len(data) * 2), [2]any{data, &dummy}}
}

// output is a float32 result copied out of ORT memory.
type output struct {
	data  []float32
	shape []int64
}

// value is a tensor ORT allocated (a run's output). It stays valid until
// released and can be fed to later runs as is, as a decoder cache is.
type value struct {
	o   *ortLib
	ptr uintptr
}

func (v *value) release() {
	if v != nil && v.ptr != 0 {
		v.o.call(fnReleaseValue, v.ptr)
		v.ptr = 0
	}
}

func releaseValues(vals map[string]*value) {
	for _, v := range vals {
		v.release()
	}
}

// run feeds named inputs and returns the requested float outputs.
func (s *session) run(inputs map[string]tensor, outputs ...string) (map[string]output, error) {
	vals, err := s.runValues(context.Background(), inputs, nil, outputs)
	if err != nil {
		return nil, err
	}
	defer releaseValues(vals)
	res := make(map[string]output, len(outputs))
	for _, name := range outputs {
		out, err := vals[name].floats()
		if err != nil {
			return nil, fmt.Errorf("output %s: %w", name, err)
		}
		res[name] = out
	}
	return res, nil
}

// runValues feeds every session input, from Go memory (inputs) or from
// values of earlier runs (kept, which the run does not release), and returns
// the requested outputs, which the caller releases. Cancelling ctx stops the
// run inside ORT.
func (s *session) runValues(ctx context.Context, inputs map[string]tensor, kept map[string]*value, outputs []string) (map[string]*value, error) {
	o := s.o
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	names := make([][]byte, 0, len(s.inputs))
	namePtrs := make([]uintptr, 0, len(s.inputs))
	values := make([]uintptr, 0, len(s.inputs))
	var created []uintptr
	keep := make([]any, 0, len(inputs))
	defer func() {
		for _, v := range created {
			o.call(fnReleaseValue, v)
		}
		runtime.KeepAlive(keep)
		runtime.KeepAlive(names)
	}()
	for _, name := range s.inputs {
		var v uintptr
		if kv, ok := kept[name]; ok && kv != nil && kv.ptr != 0 {
			v = kv.ptr
		} else if t, ok := inputs[name]; ok {
			shape := t.shape
			if len(shape) == 0 {
				shape = []int64{}
			}
			var shapePtr uintptr
			if len(shape) > 0 {
				shapePtr = uintptr(unsafe.Pointer(&shape[0]))
			}
			err := o.check(o.call(fnCreateTensorWithDataAsOrtValue, o.memInfo, uintptr(t.data), t.bytes,
				shapePtr, uintptr(len(shape)), uintptr(t.elem), uintptr(unsafe.Pointer(&v))))
			keep = append(keep, t.keep, shape)
			if err != nil {
				return nil, fmt.Errorf("input %s: %w", name, err)
			}
			created = append(created, v)
		} else {
			return nil, fmt.Errorf("missing input %q", name)
		}
		values = append(values, v)
		n := cString(name)
		names = append(names, n)
		namePtrs = append(namePtrs, uintptr(unsafe.Pointer(&n[0])))
	}
	outNames := make([][]byte, len(outputs))
	outPtrs := make([]uintptr, len(outputs))
	for i, n := range outputs {
		outNames[i] = cString(n)
		outPtrs[i] = uintptr(unsafe.Pointer(&outNames[i][0]))
	}
	outVals := make([]uintptr, len(outputs))
	var inPtr, valPtr uintptr
	if len(namePtrs) > 0 {
		inPtr, valPtr = uintptr(unsafe.Pointer(&namePtrs[0])), uintptr(unsafe.Pointer(&values[0]))
	}
	var runOpts uintptr
	if ctx.Done() != nil {
		if err := o.check(o.call(fnCreateRunOptions, uintptr(unsafe.Pointer(&runOpts)))); err != nil {
			return nil, err
		}
		// The terminate callback may run concurrently with the end of the run;
		// the lock keeps it from using the options after they are released.
		var mu sync.Mutex
		live := true
		stop := context.AfterFunc(ctx, func() {
			mu.Lock()
			if live {
				o.call(fnRunOptionsSetTerminate, runOpts)
			}
			mu.Unlock()
		})
		defer func() {
			stop()
			mu.Lock()
			live = false
			o.call(fnReleaseRunOptions, runOpts)
			mu.Unlock()
		}()
	}
	err := o.check(o.call(fnRun, s.ptr, runOpts, inPtr, valPtr, uintptr(len(values)),
		uintptr(unsafe.Pointer(&outPtrs[0])), uintptr(len(outputs)), uintptr(unsafe.Pointer(&outVals[0]))))
	runtime.KeepAlive(namePtrs)
	runtime.KeepAlive(outNames)
	runtime.KeepAlive(outPtrs)
	if err != nil {
		for _, v := range outVals {
			if v != 0 {
				o.call(fnReleaseValue, v)
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	res := make(map[string]*value, len(outputs))
	for i, name := range outputs {
		res[name] = &value{o: o, ptr: outVals[i]}
	}
	return res, nil
}

// floats copies a float32 or float16 tensor out as float32.
func (v *value) floats() (output, error) {
	o := v.o
	var info uintptr
	if err := o.check(o.call(fnGetTensorTypeAndShape, v.ptr, uintptr(unsafe.Pointer(&info)))); err != nil {
		return output{}, err
	}
	defer o.call(fnReleaseTensorTypeAndShapeInfo, info)
	var elem uintptr
	if err := o.check(o.call(fnGetTensorElementType, info, uintptr(unsafe.Pointer(&elem)))); err != nil {
		return output{}, err
	}
	if elem != elemFloat && elem != elemFloat16 {
		return output{}, fmt.Errorf("unexpected tensor element type %d", elem)
	}
	var dims uintptr
	if err := o.check(o.call(fnGetDimensionsCount, info, uintptr(unsafe.Pointer(&dims)))); err != nil {
		return output{}, err
	}
	shape := make([]int64, dims)
	if dims > 0 {
		if err := o.check(o.call(fnGetDimensions, info, uintptr(unsafe.Pointer(&shape[0])), dims)); err != nil {
			return output{}, err
		}
	}
	var count uintptr
	if err := o.check(o.call(fnGetTensorShapeElementCount, info, uintptr(unsafe.Pointer(&count)))); err != nil {
		return output{}, err
	}
	var p uintptr
	if err := o.check(o.call(fnGetTensorMutableData, v.ptr, uintptr(unsafe.Pointer(&p)))); err != nil {
		return output{}, err
	}
	data := make([]float32, count)
	if count > 0 && p != 0 {
		if elem == elemFloat {
			copy(data, unsafe.Slice((*float32)(cptr(p)), count))
		} else {
			for i, h := range unsafe.Slice((*uint16)(cptr(p)), count) {
				data[i] = f16ToF32(h)
			}
		}
	}
	return output{data: data, shape: shape}, nil
}

// f16ToF32 converts an IEEE 754 half exactly.
func f16ToF32(h uint16) float32 {
	sign := uint32(h>>15) << 31
	exp := uint32(h>>10) & 0x1f
	man := uint32(h) & 0x3ff
	switch {
	case exp == 0x1f:
		return math.Float32frombits(sign | 0x7f800000 | man<<13)
	case exp != 0:
		return math.Float32frombits(sign | (exp+112)<<23 | man<<13)
	case man == 0:
		return math.Float32frombits(sign)
	}
	// Subnormal: normalize the mantissa.
	e := uint32(113)
	for man&0x400 == 0 {
		man <<= 1
		e--
	}
	return math.Float32frombits(sign | e<<23 | (man&0x3ff)<<13)
}
