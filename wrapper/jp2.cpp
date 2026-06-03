// Minimal embind wrapper around libopenjp2 exposing the two things the
// cornerstone build did not: cp_reduce (resolution factor) AND opj_set_decode_area
// (windowed decode). Scope is what STEX needs for a JP2 visualizer mirroring
// the COG one: take an encoded J2K/JP2 byte slice, decode at a given reduce
// level, optionally within a window, return an interleaved 8-bit RGB buffer.
//
// Builds against libopenjp2.a produced by emcmake.

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

extern "C" {
#include "openjpeg.h"
}

namespace {

struct MemStream {
    const std::uint8_t* data;
    std::size_t len;
    std::size_t pos;
};

OPJ_SIZE_T mem_read(void* buffer, OPJ_SIZE_T nb_bytes, void* user_data) {
    auto* s = static_cast<MemStream*>(user_data);
    if (s->pos >= s->len) return static_cast<OPJ_SIZE_T>(-1);
    OPJ_SIZE_T n = std::min(static_cast<OPJ_SIZE_T>(s->len - s->pos), nb_bytes);
    std::memcpy(buffer, s->data + s->pos, n);
    s->pos += n;
    return n;
}

OPJ_OFF_T mem_skip(OPJ_OFF_T nb_bytes, void* user_data) {
    auto* s = static_cast<MemStream*>(user_data);
    if (nb_bytes < 0) return -1;
    auto remain = static_cast<OPJ_OFF_T>(s->len - s->pos);
    OPJ_OFF_T n = std::min(remain, nb_bytes);
    s->pos += static_cast<std::size_t>(n);
    return n;
}

OPJ_BOOL mem_seek(OPJ_OFF_T nb_bytes, void* user_data) {
    auto* s = static_cast<MemStream*>(user_data);
    if (nb_bytes < 0) return OPJ_FALSE;
    s->pos = std::min(static_cast<std::size_t>(nb_bytes), s->len);
    return OPJ_TRUE;
}

void mem_free(void* user_data) {
    delete static_cast<MemStream*>(user_data);
}

void msg_error(const char* msg, void* sink) {
    if (sink && msg) static_cast<std::string*>(sink)->append(msg);
}
void msg_quiet(const char*, void*) {}

// Detect codestream type from first 4 bytes.
//   0xFF 0x4F 0xFF 0x51  -> raw J2K (SOC + SIZ)
//   anything else        -> assume JP2 box wrapping
OPJ_CODEC_FORMAT detect_codec(const std::uint8_t* data) {
    if (data[0] == 0xFF && data[1] == 0x4F && data[2] == 0xFF && data[3] == 0x51) {
        return OPJ_CODEC_J2K;
    }
    return OPJ_CODEC_JP2;
}

}  // namespace

class DecodeResult {
public:
    // Interleaved 8-bit RGB (or grayscale if numComps == 1).
    emscripten::val pixels() const {
        return emscripten::val(emscripten::typed_memory_view(rgb_.size(), rgb_.data()));
    }
    std::uint32_t width() const { return width_; }
    std::uint32_t height() const { return height_; }
    std::uint32_t numComponents() const { return numComps_; }
    std::string error() const { return error_; }
    bool ok() const { return error_.empty(); }

    std::vector<std::uint8_t> rgb_;
    std::uint32_t width_{0};
    std::uint32_t height_{0};
    std::uint32_t numComps_{0};
    std::string error_;
};

// Public decode entry: pass a Uint8Array of the encoded bytes, an optional
// reduce level, and an optional decode area in full-resolution reference-grid
// pixels. The area is clamped to the image extent inside OpenJPEG.
DecodeResult decode(const emscripten::val& encoded,
                    std::uint32_t reduceLevel,
                    bool useArea,
                    std::int32_t areaX0,
                    std::int32_t areaY0,
                    std::int32_t areaX1,
                    std::int32_t areaY1) {
    DecodeResult out;

    // Copy the encoded bytes out of JS-land into a C++ vector. Embind's
    // typed_memory_view would be zero-copy but ownership semantics across the
    // detached buffer get fiddly; this is the safe path for a spike.
    const std::uint32_t encLen = encoded["length"].as<std::uint32_t>();
    std::vector<std::uint8_t> enc(encLen);
    emscripten::val view{emscripten::typed_memory_view(enc.size(), enc.data())};
    view.call<void>("set", encoded);

    if (enc.size() < 12) {
        out.error_ = "encoded buffer too short";
        return out;
    }

    auto* stream = new MemStream{enc.data(), enc.size(), 0};
    opj_stream_t* opj_stream = opj_stream_default_create(OPJ_TRUE);
    if (!opj_stream) {
        delete stream;
        out.error_ = "opj_stream_default_create failed";
        return out;
    }
    opj_stream_set_read_function(opj_stream, mem_read);
    opj_stream_set_skip_function(opj_stream, mem_skip);
    opj_stream_set_seek_function(opj_stream, mem_seek);
    opj_stream_set_user_data(opj_stream, stream, mem_free);
    opj_stream_set_user_data_length(opj_stream, static_cast<OPJ_UINT64>(enc.size()));

    opj_codec_t* codec = opj_create_decompress(detect_codec(enc.data()));
    if (!codec) {
        opj_stream_destroy(opj_stream);
        out.error_ = "opj_create_decompress failed";
        return out;
    }

    opj_set_error_handler(codec, msg_error, &out.error_);
    opj_set_warning_handler(codec, msg_quiet, nullptr);
    opj_set_info_handler(codec, msg_quiet, nullptr);

    opj_dparameters_t params;
    opj_set_default_decoder_parameters(&params);
    params.cp_reduce = reduceLevel;
    if (!opj_setup_decoder(codec, &params)) {
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        if (out.error_.empty()) out.error_ = "opj_setup_decoder failed";
        return out;
    }

    opj_image_t* image = nullptr;
    if (!opj_read_header(opj_stream, codec, &image)) {
        if (image) opj_image_destroy(image);
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        if (out.error_.empty()) out.error_ = "opj_read_header failed";
        return out;
    }

    if (useArea) {
        if (!opj_set_decode_area(codec, image, areaX0, areaY0, areaX1, areaY1)) {
            opj_image_destroy(image);
            opj_destroy_codec(codec);
            opj_stream_destroy(opj_stream);
            if (out.error_.empty()) out.error_ = "opj_set_decode_area failed";
            return out;
        }
    }

    if (!opj_decode(codec, opj_stream, image) ||
        !opj_end_decompress(codec, opj_stream)) {
        opj_image_destroy(image);
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        if (out.error_.empty()) out.error_ = "opj_decode failed";
        return out;
    }

    const OPJ_UINT32 numComps = image->numcomps;
    if (numComps < 1 || numComps > 4) {
        opj_image_destroy(image);
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        out.error_ = "unsupported component count " + std::to_string(numComps);
        return out;
    }

    const std::uint32_t w = image->comps[0].w;
    const std::uint32_t h = image->comps[0].h;
    if (w == 0 || h == 0) {
        opj_image_destroy(image);
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        out.error_ = "degenerate output size";
        return out;
    }
    for (OPJ_UINT32 c = 1; c < numComps; ++c) {
        if (image->comps[c].w != w || image->comps[c].h != h) {
            opj_image_destroy(image);
            opj_destroy_codec(codec);
            opj_stream_destroy(opj_stream);
            out.error_ = "component size mismatch (scope: planar-uniform RGB)";
            return out;
        }
    }

    // Planar int32 → interleaved uint8. S2 TCI is unsigned 8-bit per component,
    // but each plane is still stored as int32 in OpenJPEG. We clamp defensively.
    const std::size_t pixels = static_cast<std::size_t>(w) * h;
    out.rgb_.resize(pixels * numComps);
    for (OPJ_UINT32 c = 0; c < numComps; ++c) {
        const OPJ_INT32* src = image->comps[c].data;
        std::uint8_t* dst = out.rgb_.data() + c;
        for (std::size_t i = 0; i < pixels; ++i) {
            OPJ_INT32 v = src[i];
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            *dst = static_cast<std::uint8_t>(v);
            dst += numComps;
        }
    }
    out.width_ = w;
    out.height_ = h;
    out.numComps_ = numComps;

    opj_image_destroy(image);
    opj_destroy_codec(codec);
    opj_stream_destroy(opj_stream);
    return out;
}

EMSCRIPTEN_BINDINGS(stex_jp2) {
    emscripten::class_<DecodeResult>("DecodeResult")
        .function("pixels", &DecodeResult::pixels)
        .function("width", &DecodeResult::width)
        .function("height", &DecodeResult::height)
        .function("numComponents", &DecodeResult::numComponents)
        .function("error", &DecodeResult::error)
        .function("ok", &DecodeResult::ok);

    emscripten::function("decode", &decode);
}
