ARG BASE_IMAGE=debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
FROM ${BASE_IMAGE} AS builder

ARG VERILATOR_VERSION
ARG VERILATOR_COMMIT
ARG YOSYS_VERSION
ARG YOSYS_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autoconf \
        bison \
        build-essential \
        ca-certificates \
        flex \
        gawk \
        git \
        help2man \
        libboost-filesystem-dev \
        libboost-python-dev \
        libboost-system-dev \
        libffi-dev \
        libfl-dev \
        libjemalloc-dev \
        libreadline-dev \
        pkg-config \
        python3-dev \
        tcl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --filter=blob:none https://github.com/verilator/verilator.git /src/verilator \
    && cd /src/verilator \
    && git checkout --detach "${VERILATOR_COMMIT}" \
    && test "$(git rev-parse HEAD)" = "${VERILATOR_COMMIT}" \
    && autoconf \
    && ./configure --prefix=/opt/eda \
    && make -j"$(nproc)" \
    && make install \
    && /opt/eda/bin/verilator --version | grep -F "Verilator ${VERILATOR_VERSION}"

RUN git clone --filter=blob:none https://github.com/YosysHQ/yosys.git /src/yosys \
    && cd /src/yosys \
    && git checkout --detach "${YOSYS_COMMIT}" \
    && test "$(git rev-parse HEAD)" = "${YOSYS_COMMIT}" \
    && git submodule update --init --recursive \
    && make config-gcc \
    && make -j"$(nproc)" PREFIX=/opt/eda \
    && make install PREFIX=/opt/eda \
    && /opt/eda/bin/yosys -V | grep -F "Yosys ${YOSYS_VERSION}"

FROM ${BASE_IMAGE} AS runtime

ARG VERILATOR_VERSION
ARG VERILATOR_COMMIT
ARG YOSYS_VERSION
ARG YOSYS_COMMIT

LABEL org.opencontainers.image.title="XylonStudio pinned EDA runtime" \
      org.opencontainers.image.source="https://github.com/pcircle-com/xylon" \
      io.xylon.verilator.version="${VERILATOR_VERSION}" \
      io.xylon.verilator.commit="${VERILATOR_COMMIT}" \
      io.xylon.yosys.version="${YOSYS_VERSION}" \
      io.xylon.yosys.commit="${YOSYS_COMMIT}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libffi8 \
        libfl2 \
        libjemalloc2 \
        libreadline8 \
        perl \
        pkg-config \
        python3 \
        tcl8.6 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/eda /opt/eda

ENV PATH="/opt/eda/bin:${PATH}" \
    HOME=/tmp \
    VERILATOR_ROOT=/opt/eda/share/verilator

WORKDIR /results
CMD ["sleep", "infinity"]
