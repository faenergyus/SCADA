/**
 * Gibbs Wave Equation — Downhole Card Calculator
 *
 * Transfer matrix (Fourier) solution of the 1D damped wave equation
 * for sucker rod pump systems.
 *
 * Method:
 *   1. Decompose surface card (position + load) into Fourier harmonics
 *   2. For each harmonic, propagate through the tapered rod string using
 *      per-section 2×2 transfer matrices with COMPLEX wave numbers (damping)
 *   3. Reconstruct the downhole card via inverse DFT
 *   4. Subtract buoyant rod weight to get net pump load
 *
 * The complex wave number κ incorporates viscous damping directly into
 * the transfer matrix, so energy is properly attenuated through each
 * rod section. This correctly models impedance changes at taper transitions.
 *
 * Wave equation:  ∂²u/∂t² + c_d·∂u/∂t = c²·∂²u/∂x²
 * For harmonic n: κ_n² = (ω_n² − i·c_d·ω_n) / c²
 *
 * Transfer matrix for section j of length L, wave speed c, impedance EA:
 *   | cos(κL)           sin(κL)/(EA·κ) |
 *   | −EA·κ·sin(κL)     cos(κL)        |
 *
 * References:
 *   - Gibbs, S.G. "Predicting the Behavior of Sucker-Rod Pumping Systems"
 *     JPT, July 1963 (SPE-588-PA)
 *   - Everitt, T.A. & Jennings, J.W. "An Improved Finite-Difference
 *     Calculation of Downhole Dynamometer Cards" SPE 18189, 1992
 *   - Schafer, D.J. & Jennings, J.W. "An Investigation of Analytical
 *     and Numerical Sucker Rod Pumping Models" SPE 16919, 1987
 */

var WaveEquation = (function () {
    'use strict';

    // ===================================================================
    // Physical constants
    // ===================================================================
    var STEEL_WEIGHT_DENSITY = 0.2833;  // lbf/in³ (weight density, NOT mass)
    var STEEL_ELASTICITY = 30.5e6;      // psi (Young's modulus for steel rods)
    var GRAVITY = 386.4;                // in/s² (gravitational acceleration)
    var PI = Math.PI;

    // ===================================================================
    // Rod model builder
    // ===================================================================

    /**
     * Build a rod model from XSPOC rod_string and well_details data.
     *
     * Rod sections are ordered from surface (RodNum=1) to pump.
     * Each section stores: length (in), diameter (in), area (in²),
     * EA (lbs), wave speed (in/s), weight density (lbf/in³).
     *
     * Wave speed = sqrt(E·g / ρ_weight) where ρ_weight is in lbf/in³.
     * For steel: c ≈ sqrt(30.5e6 × 386.4 / 0.2833) ≈ 203,900 in/s ≈ 16,990 ft/s
     */
    function buildRodModel(rodSections, wellDetails) {
        if (!rodSections || rodSections.length === 0) return null;

        var sections = rodSections.slice().sort(function (a, b) {
            return (a.RodNum || 0) - (b.RodNum || 0);
        });

        var totalLength = 0;
        var model = [];

        for (var i = 0; i < sections.length; i++) {
            var s = sections[i];
            var lenIn = (s.Length || 0) * 12;       // ft → in
            var diam = s.Diameter || 0.75;           // in
            var E = s.Elasticity || STEEL_ELASTICITY; // psi
            var matlID = s.RodMatlID || 1;
            // Material densities: steel=0.2833, sinker bar=0.374, fiberglass=0.065 lbf/in³
            // Sinker bar density back-computed from XSPOC DryRodWeight values
            var wDens = (matlID === 4) ? 0.065 :
                        (matlID === 2) ? 0.374 : STEEL_WEIGHT_DENSITY;
            var area = PI * diam * diam / 4;         // in²

            model.push({
                length: lenIn,
                diameter: diam,
                area: area,
                E: E,
                EA: E * area,                         // lbs (axial stiffness)
                wDens: wDens,
                waveSpeed: Math.sqrt(E * GRAVITY / wDens),  // in/s
                weightPerIn: wDens * area,            // lbf/in (linear weight)
            });
            totalLength += lenIn;
        }

        var pumpDepth = (wellDetails.PumpDepth || 0) * 12;  // ft → in
        if (pumpDepth === 0) pumpDepth = totalLength;

        // Detect impedance mismatches for adaptive harmonic selection.
        // Large mismatches (fiberglass-steel) cause harmonic resonance in the
        // transfer matrix, requiring fewer harmonics or higher damping.
        var hasFiberglass = false;
        var maxImpedanceRatio = 1;
        for (var i = 0; i < model.length; i++) {
            if (model[i].wDens < 0.1) hasFiberglass = true;  // fiberglass density
            if (i > 0) {
                var Z_prev = model[i-1].wDens * model[i-1].area * model[i-1].waveSpeed;
                var Z_curr = model[i].wDens * model[i].area * model[i].waveSpeed;
                var ratio = Z_prev > Z_curr ? Z_curr / Z_prev : Z_prev / Z_curr;
                if (ratio < maxImpedanceRatio) maxImpedanceRatio = ratio;
            }
        }

        return {
            sections: model,
            totalLength: totalLength,
            pumpDepth: pumpDepth,
            spm: wellDetails.SPM || 8,
            strokeLength: wellDetails.StrokeLength || 100,
            plungerDiam: wellDetails.PlungerDiam || 1.5,
            fluidSG: wellDetails.FluidSpecificGravity || wellDetails.WaterSG || 1.0,
            tubingPressure: wellDetails.TubingPressure || 0,
            casingPressure: wellDetails.CasingPressure || 0,
            hasFiberglass: hasFiberglass,
            minImpedanceRatio: maxImpedanceRatio,
        };
    }

    // ===================================================================
    // Complex arithmetic helpers (inline [re, im] pairs)
    // ===================================================================
    //
    // These operate on 2-element arrays [real, imaginary].
    // For performance in the inner loop, we also use inline scalar math.

    /**
     * Complex cosine: cos(a + bi) = cos(a)·cosh(b) − i·sin(a)·sinh(b)
     */
    function ccos_re(a, b) { return Math.cos(a) * Math.cosh(b); }
    function ccos_im(a, b) { return -Math.sin(a) * Math.sinh(b); }

    /**
     * Complex sine: sin(a + bi) = sin(a)·cosh(b) + i·cos(a)·sinh(b)
     */
    function csin_re(a, b) { return Math.sin(a) * Math.cosh(b); }
    function csin_im(a, b) { return Math.cos(a) * Math.sinh(b); }

    // ===================================================================
    // Main calculator
    // ===================================================================

    /**
     * Calculate downhole card from surface card using the Gibbs transfer
     * matrix method with complex (damped) wave numbers.
     *
     * @param {Array} surfacePosition - Surface card position array (inches)
     * @param {Array} surfaceLoad     - Surface card load array (lbs)
     * @param {Object} rodModel       - From buildRodModel()
     * @param {Object} options        - { dampingFactor, nHarmonics }
     * @returns {Object} { position, load, meta } or null
     */
    function calculateDownholeCard(surfacePosition, surfaceLoad, rodModel, options) {
        if (!rodModel || !surfacePosition || !surfaceLoad) return null;
        var M = surfacePosition.length;
        if (M < 10) return null;

        var opts = options || {};

        // Damping coefficient ζ — controls viscous energy dissipation.
        //   c_d = 2·ζ·ω₀  where ω₀ = fundamental angular frequency.
        //   Typical range: 0.05 (light) to 1.0 (heavy).
        //   Higher values smooth the card (attenuate high harmonics).
        //   XSPOC typically uses 0.5 for most wells.
        var zeta = opts.dampingFactor != null ? opts.dampingFactor : 0.50;

        // Number of Fourier harmonics — adaptive based on rod string impedance.
        // Large impedance mismatches (e.g. fiberglass-steel, ratio < 0.4) cause
        // higher harmonics to resonate (|T22| > 1 with ~180° phase flip), producing
        // inverted load traces. Limiting harmonics suppresses this artifact.
        // Steel-only wells: 12 harmonics (smooth, sharp features)
        // Fiberglass wells: 6 harmonics (avoids resonance zone)
        var defaultHarm = (rodModel.hasFiberglass || rodModel.minImpedanceRatio < 0.4) ? 6 : 12;
        var maxHarm = opts.nHarmonics || defaultHarm;
        var nHarm = Math.min(Math.floor(M / 2), maxHarm);

        // Fundamental angular frequency (rad/s)
        var omega0 = 2 * PI * rodModel.spm / 60;

        // Viscous damping coefficient: c_d = 2·ζ·ω₀
        var c_d = 2 * zeta * omega0;

        // ---------------------------------------------------------------
        // Step 1: DFT of surface position and load
        //
        //   X[n] = Σ_{k=0}^{M-1} x[k] · e^{-i·2π·nk/M}
        //
        // SIGN CONVENTION: The polished rod load (PRL) is an upward
        // tension force, but the wave equation's internal force convention
        // is F = EA·du/dx with u positive downward. For a rod in tension
        // (upper part pulled up), du/dx < 0, so F < 0. Therefore:
        //   F_wave(0) = -PRL
        //
        // We negate the surface load during DFT, then negate the pump
        // load back after IDFT to return to the PRL convention.
        // ---------------------------------------------------------------
        var surfPosRe = new Float64Array(nHarm + 1);
        var surfPosIm = new Float64Array(nHarm + 1);
        var surfLoadRe = new Float64Array(nHarm + 1);
        var surfLoadIm = new Float64Array(nHarm + 1);

        for (var n = 0; n <= nHarm; n++) {
            var pr = 0, pi = 0, lr = 0, li = 0;
            for (var k = 0; k < M; k++) {
                var angle = 2 * PI * n * k / M;
                var ca = Math.cos(angle);
                var sa = Math.sin(angle);
                pr += surfacePosition[k] * ca;
                pi -= surfacePosition[k] * sa;
                // Negate load for wave equation sign convention
                lr -= surfaceLoad[k] * ca;
                li += surfaceLoad[k] * sa;
            }
            surfPosRe[n] = pr;
            surfPosIm[n] = pi;
            surfLoadRe[n] = lr;
            surfLoadIm[n] = li;
        }

        // ---------------------------------------------------------------
        // Step 2: Propagate each harmonic through the rod string
        //
        // For each Fourier harmonic n (frequency ω_n = n·ω₀):
        //   - Compute complex wave number κ_n for each rod section
        //   - Apply 2×2 transfer matrix through each section
        //
        // The state vector is [u, F] (displacement, force), both complex.
        //
        // Wave number:
        //   κ² = (ω_n² − i·c_d·ω_n) / c²
        //   κ  = ω_n/c · √(1 − i·c_d/ω_n)
        //
        // Transfer matrix for section with length L, stiffness EA:
        //   T11 = cos(κL)             T12 = sin(κL)/(EA·κ)
        //   T21 = −EA·κ·sin(κL)       T22 = cos(κL)
        //
        //   [u_out]   [T11  T12] [u_in]
        //   [F_out] = [T21  T22] [F_in]
        // ---------------------------------------------------------------
        var pumpPosRe = new Float64Array(nHarm + 1);
        var pumpPosIm = new Float64Array(nHarm + 1);
        var pumpLoadRe = new Float64Array(nHarm + 1);
        var pumpLoadIm = new Float64Array(nHarm + 1);

        for (var n = 0; n <= nHarm; n++) {
            // Current state: [u, F] as complex numbers
            var u_re = surfPosRe[n], u_im = surfPosIm[n];
            var f_re = surfLoadRe[n], f_im = surfLoadIm[n];

            if (n === 0) {
                // ── DC component (n=0, ω=0) ──
                // Static case: no wave propagation.
                // Displacement changes by elastic stretch: Δu = F·L/(EA)
                // Force stays constant (gravity handled by buoyant weight subtraction)
                for (var s = 0; s < rodModel.sections.length; s++) {
                    var sec0 = rodModel.sections[s];
                    var compliance = sec0.length / sec0.EA;  // in/lbs
                    u_re += f_re * compliance;
                    u_im += f_im * compliance;
                }
            } else {
                // ── Harmonic n > 0 ──
                var omega_n = n * omega0;  // angular frequency for this harmonic

                for (var s = 0; s < rodModel.sections.length; s++) {
                    var sec = rodModel.sections[s];
                    var c_s = sec.waveSpeed;    // in/s
                    var EA_s = sec.EA;           // lbs
                    var L_s = sec.length;        // in

                    // Complex wave number: κ² = (ω_n² − i·c_d·ω_n) / c²
                    // κ = sqrt(κ²) via polar form
                    var ksq_re = (omega_n * omega_n) / (c_s * c_s);
                    var ksq_im = -(c_d * omega_n) / (c_s * c_s);

                    var ksq_mag = Math.sqrt(ksq_re * ksq_re + ksq_im * ksq_im);
                    var ksq_arg = Math.atan2(ksq_im, ksq_re);
                    var k_mag = Math.sqrt(ksq_mag);
                    var k_arg = ksq_arg / 2;

                    var k_re = k_mag * Math.cos(k_arg);  // wave number (real part)
                    var k_im = k_mag * Math.sin(k_arg);  // wave number (imag part, < 0 for decay)

                    // Phase angle: φ = κ · L  (complex)
                    var phi_re = k_re * L_s;
                    var phi_im = k_im * L_s;

                    // Complex trig functions:
                    //   cos(a+bi) = cos(a)·cosh(b) − i·sin(a)·sinh(b)
                    //   sin(a+bi) = sin(a)·cosh(b) + i·cos(a)·sinh(b)
                    var cos_re = ccos_re(phi_re, phi_im);
                    var cos_im = ccos_im(phi_re, phi_im);
                    var sin_re = csin_re(phi_re, phi_im);
                    var sin_im = csin_im(phi_re, phi_im);

                    // EA·κ (complex): [EA·k_re, EA·k_im]
                    var eak_re = EA_s * k_re;
                    var eak_im = EA_s * k_im;

                    // T12 = sin(φ) / (EA·κ)  — complex division
                    var eak_mag2 = eak_re * eak_re + eak_im * eak_im;
                    var t12_re = (sin_re * eak_re + sin_im * eak_im) / eak_mag2;
                    var t12_im = (sin_im * eak_re - sin_re * eak_im) / eak_mag2;

                    // T21 = −EA·κ · sin(φ)  — complex multiply, negated
                    var t21_re = -(eak_re * sin_re - eak_im * sin_im);
                    var t21_im = -(eak_re * sin_im + eak_im * sin_re);

                    // Apply transfer matrix:
                    //   u_new = T11·u + T12·f  where T11 = cos(φ), T22 = cos(φ)
                    //   f_new = T21·u + T22·f
                    //
                    // Complex multiply T11·u = cos(φ)·u:
                    var cu_re = cos_re * u_re - cos_im * u_im;
                    var cu_im = cos_re * u_im + cos_im * u_re;

                    // Complex multiply T12·f:
                    var tf_re = t12_re * f_re - t12_im * f_im;
                    var tf_im = t12_re * f_im + t12_im * f_re;

                    // Complex multiply T21·u:
                    var tu_re = t21_re * u_re - t21_im * u_im;
                    var tu_im = t21_re * u_im + t21_im * u_re;

                    // Complex multiply T22·f = cos(φ)·f:
                    var cf_re = cos_re * f_re - cos_im * f_im;
                    var cf_im = cos_re * f_im + cos_im * f_re;

                    // Sum: u_new = cos(φ)·u + sin(φ)/(EA·κ)·f
                    u_re = cu_re + tf_re;
                    u_im = cu_im + tf_im;

                    // Sum: f_new = −EA·κ·sin(φ)·u + cos(φ)·f
                    f_re = tu_re + cf_re;
                    f_im = tu_im + cf_im;
                }
            }

            pumpPosRe[n] = u_re;
            pumpPosIm[n] = u_im;
            pumpLoadRe[n] = f_re;
            pumpLoadIm[n] = f_im;
        }

        // ---------------------------------------------------------------
        // Step 3: Inverse DFT to reconstruct pump card
        //
        //   x[k] = (1/M) · Σ_{n=0}^{M-1} X[n] · e^{i·2π·nk/M}
        //
        // Using conjugate symmetry for real signals: X[M−n] = X[n]*
        // Only n=0..nHarm computed; contributions doubled for 0<n<nHarm.
        // ---------------------------------------------------------------
        var dhDisp = new Float64Array(M);
        var dhLoad = new Float64Array(M);

        for (var k = 0; k < M; k++) {
            var d = 0, l = 0;
            for (var n = 0; n <= nHarm; n++) {
                var angle = 2 * PI * n * k / M;
                var ca = Math.cos(angle);
                var sa = Math.sin(angle);

                // Real part of X[n]·e^{iθ} = Re·cos(θ) − Im·sin(θ)
                var cd = pumpPosRe[n] * ca - pumpPosIm[n] * sa;
                var cl = pumpLoadRe[n] * ca - pumpLoadIm[n] * sa;

                // DC and Nyquist contribute once; all others doubled
                if (n === 0 || (n === nHarm && M % 2 === 0)) {
                    d += cd;
                    l += cl;
                } else {
                    d += 2 * cd;
                    l += 2 * cl;
                }
            }
            dhDisp[k] = d / M;
            dhLoad[k] = l / M;
        }

        // ---------------------------------------------------------------
        // Step 4: Phase alignment
        //
        // Roll the pump card so minimum position is at index 0, matching
        // XSPOC's DH card convention (bottom-of-stroke first).
        // ---------------------------------------------------------------
        var pumpMinIdx = 0, pumpMinVal = dhDisp[0];
        for (var t = 1; t < M; t++) {
            if (dhDisp[t] < pumpMinVal) {
                pumpMinVal = dhDisp[t];
                pumpMinIdx = t;
            }
        }

        if (pumpMinIdx > 0) {
            var tmpDisp = new Float64Array(M);
            var tmpLoad = new Float64Array(M);
            for (var t = 0; t < M; t++) {
                var srcIdx = (t + pumpMinIdx) % M;
                tmpDisp[t] = dhDisp[srcIdx];
                tmpLoad[t] = dhLoad[srcIdx];
            }
            dhDisp = tmpDisp;
            dhLoad = tmpLoad;
        }

        // ---------------------------------------------------------------
        // Step 5: Post-processing — normalize position, compute net load
        //
        // The load was negated on input (F = -PRL). We negate it back
        // here so positive load = tension = PRL convention.
        // Then subtract buoyant rod weight for net pump load.
        // ---------------------------------------------------------------

        // Normalize displacement (shift so minimum = 0)
        var minDH = dhDisp[0];
        for (var t = 1; t < M; t++) {
            if (dhDisp[t] < minDH) minDH = dhDisp[t];
        }

        // Buoyant rod weight: use XSPOC value if provided, else compute
        var totalBuoyantWt;
        if (opts.buoyantRodWeight) {
            totalBuoyantWt = opts.buoyantRodWeight;
        } else {
            var fluidDens = rodModel.fluidSG * 62.4 / 1728;  // lbf/in³
            totalBuoyantWt = 0;
            for (var s = 0; s < rodModel.sections.length; s++) {
                var sec_s = rodModel.sections[s];
                var buoyFactor_s = 1 - fluidDens / sec_s.wDens;
                totalBuoyantWt += sec_s.weightPerIn * sec_s.length * buoyFactor_s;
            }
        }

        // Net pump load = -(negated force) - buoyant rod weight
        var resultPos = new Array(M);
        var resultLoad = new Array(M);
        for (var t = 0; t < M; t++) {
            resultPos[t] = Math.round((dhDisp[t] - minDH) * 100) / 100;
            resultLoad[t] = Math.round(-dhLoad[t] - totalBuoyantWt);
        }

        // Metadata for display
        var avgC = 0, totalLen = 0;
        for (var s = 0; s < rodModel.sections.length; s++) {
            avgC += rodModel.sections[s].waveSpeed * rodModel.sections[s].length;
            totalLen += rodModel.sections[s].length;
        }
        avgC /= totalLen;

        return {
            position: resultPos,
            load: resultLoad,
            meta: {
                method: 'Gibbs (transfer matrix)',
                nHarmonics: nHarm,
                dampingFactor: zeta,
                dampingCoeff: Math.round(c_d * 1000) / 1000,
                pumpDepthFt: Math.round(rodModel.pumpDepth / 12),
                rodSections: rodModel.sections.length,
                avgWaveSpeedFtS: Math.round(avgC / 12),
                buoyantRodWt: Math.round(totalBuoyantWt),
                hasFiberglass: rodModel.hasFiberglass,
                impedanceRatio: Math.round(rodModel.minImpedanceRatio * 1000) / 1000,
            }
        };
    }

    // ===================================================================
    // Everitt-Jennings Finite Difference Method (SPE 18189)
    //
    // Spatial marching scheme: uses known surface position + load to
    // march displacement downward through the rod string node by node.
    // Handles tapered rods, fiberglass, and impedance mismatches naturally.
    //
    // For each spatial node i (from surface to pump):
    //   U[i,t] = A1·U[i-1,t+1] + A2·U[i-1,t] + A3·U[i-1,t-1] - U[i-2,t]
    //
    // Advantages over transfer matrix:
    //   - No harmonic truncation or Gibbs phenomenon
    //   - Phase coupling between position and load is preserved
    //   - Naturally handles large impedance mismatches
    // ===================================================================

    /**
     * Linearly interpolate array from M_orig points to M_new points (periodic).
     */
    function interpArray(arr, M_new) {
        var M_orig = arr.length;
        if (M_new === M_orig) return arr.slice();
        var result = new Float64Array(M_new);
        for (var k = 0; k < M_new; k++) {
            var t = k * M_orig / M_new;
            var i0 = Math.floor(t);
            var frac = t - i0;
            var i1 = (i0 + 1) % M_orig;
            result[k] = arr[i0] * (1 - frac) + arr[i1] * frac;
        }
        return result;
    }

    /**
     * Calculate downhole card using the Everitt-Jennings finite difference
     * spatial marching scheme.
     *
     * @param {Array} surfacePosition - Surface card position array (inches)
     * @param {Array} surfaceLoad     - Surface card load array (lbs)
     * @param {Object} rodModel       - From buildRodModel()
     * @param {Object} options        - { dampingFactor, nNodes, buoyantRodWeight }
     * @returns {Object} { position, load, meta } or null
     */
    function calculateDownholeCardFD(surfacePosition, surfaceLoad, rodModel, options) {
        if (!rodModel || !surfacePosition || !surfaceLoad) return null;
        var M_orig = surfacePosition.length;
        if (M_orig < 10) return null;

        var opts = options || {};
        var zeta = opts.dampingFactor != null ? opts.dampingFactor : 0.50;
        var omega0 = 2 * PI * rodModel.spm / 60;
        var C_damp = 2 * zeta * omega0;  // viscous damping coefficient (1/s)

        var T = 60 / rodModel.spm;  // stroke period (s)
        var totalLen = rodModel.totalLength;

        // Spatial grid: ~50 nodes gives good resolution
        var N_nodes = opts.nNodes || 50;
        var dx = totalLen / N_nodes;

        // Find min wave speed across all sections (CFL constraint)
        var minWaveSpeed = Infinity;
        for (var s = 0; s < rodModel.sections.length; s++) {
            if (rodModel.sections[s].waveSpeed < minWaveSpeed)
                minWaveSpeed = rodModel.sections[s].waveSpeed;
        }

        // CFL for spatial marching: dt >= dx / c_min
        // (opposite of time-marching CFL — the spatial Courant number
        //  r_s = dx/(c·dt) must be <= 1 for stability)
        var dt = dx / (0.95 * minWaveSpeed);
        var M_fine = Math.ceil(T / dt);
        dt = T / M_fine;  // adjust to fit cycle exactly

        // Effective loads: subtract DC (mean) to avoid cancellation error.
        // The spatial marching scheme differences large displacements to get
        // small forces. Working with effective (AC) values keeps magnitudes small.
        var posMean = 0, loadMean = 0;
        for (var k = 0; k < M_orig; k++) {
            posMean += surfacePosition[k];
            loadMean += surfaceLoad[k];
        }
        posMean /= M_orig;
        loadMean /= M_orig;

        var surfPosEff = new Array(M_orig);
        var surfLoadEff = new Array(M_orig);
        for (var k = 0; k < M_orig; k++) {
            surfPosEff[k] = surfacePosition[k] - posMean;
            surfLoadEff[k] = surfaceLoad[k] - loadMean;
        }

        // Interpolate effective surface card to fine time grid
        var surfPosFine = interpArray(surfPosEff, M_fine);
        var surfLoadFine = interpArray(surfLoadEff, M_fine);

        // Map each spatial node to a rod section (by cumulative length)
        function getPropsAtDepth(depth) {
            var cumLen = 0;
            for (var s = 0; s < rodModel.sections.length; s++) {
                var sec = rodModel.sections[s];
                if (depth <= cumLen + sec.length || s === rodModel.sections.length - 1) {
                    return sec;
                }
                cumLen += sec.length;
            }
            return rodModel.sections[rodModel.sections.length - 1];
        }

        // Allocate working arrays (only need 3 spatial levels)
        var U_im2 = new Float64Array(M_fine);  // U[i-2, :]
        var U_im1 = new Float64Array(M_fine);  // U[i-1, :]
        var U_i   = new Float64Array(M_fine);  // U[i, :] (current)

        // Node 0: surface position
        for (var t = 0; t < M_fine; t++) {
            U_im2[t] = surfPosFine[t];
        }

        // Node 1: Hooke's law — U[1] = U[0] + F_surface * dx / EA
        var sec0 = getPropsAtDepth(0);
        for (var t = 0; t < M_fine; t++) {
            U_im1[t] = U_im2[t] + surfLoadFine[t] * dx / sec0.EA;
        }

        // Spatial march from node 2 to node N
        for (var i = 2; i <= N_nodes; i++) {
            var depth = (i - 0.5) * dx;  // midpoint between i-1 and i
            var sec = getPropsAtDepth(depth);

            // FD coefficients (Everitt-Jennings)
            //   alpha = (dx / dt²) * mass_per_length
            //   mass_per_length = wDens * area / gravity
            var mpl = sec.wDens * sec.area / GRAVITY;  // lbf·s²/in²
            var alpha = (dx / (dt * dt)) * mpl;
            var EA_dx = sec.EA / dx;

            var A1 = alpha * (1 + C_damp * dt) / EA_dx;
            var A2 = -(alpha * (2 + C_damp * dt) - 2 * EA_dx) / EA_dx;
            var A3 = alpha / EA_dx;
            // A4 = -1 (coefficient for U[i-2, t])

            for (var t = 0; t < M_fine; t++) {
                var t_next = (t + 1) % M_fine;
                var t_prev = (t - 1 + M_fine) % M_fine;

                U_i[t] = A1 * U_im1[t_next] + A2 * U_im1[t] + A3 * U_im1[t_prev] - U_im2[t];
            }

            // Shift arrays: im2 ← im1, im1 ← i
            var tmp = U_im2;
            U_im2 = U_im1;
            U_im1 = U_i;
            U_i = tmp;  // reuse buffer
        }

        // After loop: U_im1 = U[N], U_im2 = U[N-1]
        // Effective pump force from strain at pump depth
        var secPump = getPropsAtDepth(totalLen);
        var dhLoadFine = new Float64Array(M_fine);
        for (var t = 0; t < M_fine; t++) {
            dhLoadFine[t] = (secPump.EA / dx) * (U_im1[t] - U_im2[t]);
        }

        // Add back DC offset: net pump load = F_eff + (mean_PRL - W_buoyant)
        // The effective force oscillates around zero; the DC component is the
        // static pump force (mean surface load minus buoyant rod weight).
        var dcOffset = loadMean;  // buoyant weight subtracted below

        // Sample back to original time grid
        var sampleRatio = M_fine / M_orig;
        var dhDisp = new Float64Array(M_orig);
        var dhLoad = new Float64Array(M_orig);
        for (var t = 0; t < M_orig; t++) {
            var tf = Math.round(t * sampleRatio) % M_fine;
            dhDisp[t] = U_im1[tf] + posMean;  // add back position DC
            dhLoad[t] = dhLoadFine[tf] + dcOffset;  // add back load DC
        }

        // Phase alignment: roll so min position is at index 0
        var pumpMinIdx = 0, pumpMinVal = dhDisp[0];
        for (var t = 1; t < M_orig; t++) {
            if (dhDisp[t] < pumpMinVal) {
                pumpMinVal = dhDisp[t];
                pumpMinIdx = t;
            }
        }
        if (pumpMinIdx > 0) {
            var tmpD = new Float64Array(M_orig);
            var tmpL = new Float64Array(M_orig);
            for (var t = 0; t < M_orig; t++) {
                var src = (t + pumpMinIdx) % M_orig;
                tmpD[t] = dhDisp[src];
                tmpL[t] = dhLoad[src];
            }
            dhDisp = tmpD;
            dhLoad = tmpL;
        }

        // Normalize position
        var minDH = dhDisp[0];
        for (var t = 1; t < M_orig; t++) {
            if (dhDisp[t] < minDH) minDH = dhDisp[t];
        }

        // Buoyant rod weight
        var totalBuoyantWt;
        if (opts.buoyantRodWeight) {
            totalBuoyantWt = opts.buoyantRodWeight;
        } else {
            var fluidDens = rodModel.fluidSG * 62.4 / 1728;
            totalBuoyantWt = 0;
            for (var s = 0; s < rodModel.sections.length; s++) {
                var sec_s = rodModel.sections[s];
                var buoyFactor_s = 1 - fluidDens / sec_s.wDens;
                totalBuoyantWt += sec_s.weightPerIn * sec_s.length * buoyFactor_s;
            }
        }

        // Net pump load = rod force at pump − buoyant rod weight
        var resultPos = new Array(M_orig);
        var resultLoad = new Array(M_orig);
        for (var t = 0; t < M_orig; t++) {
            resultPos[t] = Math.round((dhDisp[t] - minDH) * 100) / 100;
            resultLoad[t] = Math.round(dhLoad[t] - totalBuoyantWt);
        }

        // Metadata
        var avgC = 0, tLen = 0;
        for (var s = 0; s < rodModel.sections.length; s++) {
            avgC += rodModel.sections[s].waveSpeed * rodModel.sections[s].length;
            tLen += rodModel.sections[s].length;
        }
        avgC /= tLen;

        return {
            position: resultPos,
            load: resultLoad,
            meta: {
                method: 'Everitt-Jennings FD',
                spatialNodes: N_nodes,
                timeSteps: M_fine,
                dampingFactor: zeta,
                dampingCoeff: Math.round(C_damp * 1000) / 1000,
                pumpDepthFt: Math.round(rodModel.pumpDepth / 12),
                rodSections: rodModel.sections.length,
                avgWaveSpeedFtS: Math.round(avgC / 12),
                buoyantRodWt: Math.round(totalBuoyantWt),
                hasFiberglass: rodModel.hasFiberglass,
                impedanceRatio: Math.round(rodModel.minImpedanceRatio * 1000) / 1000,
            }
        };
    }

    // ===================================================================
    // Ideal (theoretical) downhole card
    // ===================================================================

    /**
     * Generate an ideal downhole card for a fully-loaded pump.
     * Used as a reference shape for pattern matching.
     *
     * Ideal card is rectangular with:
     *   - Upstroke load = fluid_load + tubing_pressure_load − casing_pressure_load
     *   - Downstroke load = max(0, tubing_pressure_load − casing_pressure_load)
     *   - Sharp transitions at top and bottom of stroke
     */
    function idealDownholeCard(rodModel, netStroke) {
        if (!rodModel) return null;
        var plungerArea = PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
        var fluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
        var tubLoad = rodModel.tubingPressure * plungerArea;
        var casLoad = rodModel.casingPressure * plungerArea;
        var upLoad = fluidLoad + tubLoad - casLoad;
        var downLoad = Math.max(0, tubLoad - casLoad);
        var stroke = netStroke || rodModel.strokeLength * 0.9;
        var N = 100, pos = [], load = [];
        for (var i = 0; i < N; i++) {
            var f = i / (N - 1);
            if (f < 0.02) {
                pos.push(0);
                load.push(downLoad + (upLoad - downLoad) * f / 0.02);
            } else if (f < 0.5) {
                pos.push(stroke * (f - 0.02) / 0.48);
                load.push(upLoad);
            } else if (f < 0.52) {
                pos.push(stroke);
                load.push(upLoad - (upLoad - downLoad) * (f - 0.5) / 0.02);
            } else {
                pos.push(stroke * (1 - (f - 0.52) / 0.48));
                load.push(downLoad);
            }
        }
        return {
            position: pos,
            load: load,
            meta: { fluidLoad: Math.round(upLoad), downstrokeLoad: Math.round(downLoad) }
        };
    }

    // ===================================================================
    // Public API
    // ===================================================================
    return {
        buildRodModel: buildRodModel,
        calculateDownholeCard: calculateDownholeCard,  // transfer matrix (primary)
        calculateDownholeCardFD: calculateDownholeCardFD,  // FD (experimental)
        idealDownholeCard: idealDownholeCard,
    };
})();
