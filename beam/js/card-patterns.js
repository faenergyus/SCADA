/**
 * Dyno Card Pattern Database & Diagnostic Engine
 *
 * Classifies downhole dynamometer cards by comparing shape features
 * against known pump condition patterns. Uses geometric analysis
 * (area ratios, load transitions, symmetry) rather than image matching.
 *
 * Sources:
 *   - Theta/XSPOC XDiag condition taxonomy
 *   - API RP 11L2 "Recommended Practice for Electrical Submersible Pump Testing"
 *   - Gibbs, S.G. "Computing Gearbox Torque and Motor Loading" (SPE 18186)
 *   - Industry standard card shape classifications
 */

const CardPatterns = (function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Pattern Database
    // -----------------------------------------------------------------------
    /**
     * Each pattern describes the expected shape features of a downhole card
     * for a specific pump condition.
     *
     * Shape features extracted from each card:
     *   - areaRatio:        actual card area / ideal rectangular card area
     *   - loadRange:        (maxLoad - minLoad) as fraction of ideal fluid load
     *   - upstrokeSlope:    normalized slope of load during upstroke
     *   - downstrokeSlope:  normalized slope of load during downstroke
     *   - tvTransition:     sharpness of load pickup at bottom (TV closing)
     *   - svTransition:     sharpness of load drop at top (SV closing)
     *   - symmetry:         how symmetric the card is about the midpoint
     *   - flatTop:          fraction of upstroke at near-constant load
     *   - flatBottom:       fraction of downstroke at near-constant load
     *   - fluidPoundIdx:    sharp load drop during downstroke (0-1)
     *   - gasCompression:   gradual load buildup during upstroke (0-1)
     */
    // Pattern thresholds calibrated against 64 real XSPOC wells (2026-03-23).
    // Feature statistics computed per XSPOC PumpCondition class and used to set
    // min/max/ideal values for each discriminating feature.
    var PATTERNS = [
        {
            id: 'full_pump',
            name: 'Full Pump',
            severity: 'normal',
            description: 'Pump is operating normally with full fillage. Card is approximately rectangular.',
            operationalMeaning: 'Pump barrel is completely filled with fluid each stroke. Optimal production.',
            actions: ['No action needed', 'Monitor for changes'],
            features: {
                areaRatio: { min: 0.72, ideal: 0.85, max: 1.0 },
                flatBottom: { min: 0.60, ideal: 0.80 },
                tvTransition: { min: 0.8, ideal: 1.0 },
                svTransition: { min: 0.8, ideal: 1.0 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.0,
        },
        {
            id: 'fluid_pound',
            name: 'Fluid Pound',
            severity: 'warning',
            description: 'Pump barrel not completely filled — plunger hits fluid on downstroke causing sharp load spike. Card shows truncated lower-right corner.',
            operationalMeaning: 'Pump speed exceeds fluid inflow rate. Barrel partially gas-filled. Causes rod and surface equipment fatigue.',
            actions: [
                'Slow pump speed (reduce SPM)',
                'Lower pump if possible',
                'Check for gas interference',
                'Verify fluid level vs pump depth',
            ],
            features: {
                areaRatio: { min: 0.15, ideal: 0.50, max: 0.80 },
                fluidPoundIdx: { min: 0.10, ideal: 0.35 },
                svTransition: { max: 0.55 },
            },
            weight: 1.2,
        },
        {
            id: 'gas_interference',
            name: 'Gas Interference',
            severity: 'warning',
            description: 'Free gas in pump barrel compresses before valves transfer. Card shows gradual load buildup on upstroke and gradual unloading on downstroke — "banana" or "football" shape.',
            operationalMeaning: 'Gas entering pump with fluid. Reduces pump efficiency. Gas must compress before TV opens.',
            actions: [
                'Install or check gas separator/anchor',
                'Lower pump below perforations if possible',
                'Consider gas venting',
                'Check casing pressure management',
            ],
            features: {
                areaRatio: { min: 0.35, ideal: 0.58, max: 0.70 },
                flatBottom: { max: 0.45 },
                flatTop: { max: 0.55 },
                fluidPoundIdx: { max: 0.35 },
            },
            weight: 1.1,
        },
        {
            id: 'tv_leak',
            name: 'Traveling Valve Leak',
            severity: 'warning',
            description: 'Traveling valve not seating properly. Fluid leaks past TV during upstroke. Card shows declining load during upstroke (sloping top).',
            operationalMeaning: 'TV ball or seat worn/damaged. Fluid falls back through TV during upstroke, reducing lift.',
            actions: [
                'Pull rods and replace TV',
                'Check for sand/debris in valve',
                'Monitor for worsening',
            ],
            features: {
                flatTop: { max: 0.55, ideal: 0.40 },
                flatBottom: { min: 0.45, ideal: 0.75 },
                areaRatio: { min: 0.55, max: 0.90 },
                fluidPoundIdx: { max: 0.12 },
            },
            weight: 1.15,
        },
        {
            id: 'sv_leak',
            name: 'Standing Valve Leak',
            severity: 'warning',
            description: 'Standing valve not seating properly. Fluid leaks past SV during downstroke. Card shows rising load during downstroke (sloping bottom).',
            operationalMeaning: 'SV ball or seat worn/damaged. Fluid falls back through SV during downstroke.',
            actions: [
                'Pull tubing and replace SV',
                'Check for sand/debris',
                'Verify SV type matches well conditions',
            ],
            features: {
                flatBottom: { max: 0.55, ideal: 0.35 },
                areaRatio: { min: 0.40, max: 0.90 },
                svTransition: { max: 0.50 },
                fluidPoundIdx: { max: 0.25 },
            },
            weight: 1.15,
        },
        {
            id: 'worn_pump',
            name: 'Worn Pump / Barrel Wear',
            severity: 'caution',
            description: 'Pump barrel or plunger worn — fluid slips past plunger during both strokes. Card appears "squeezed" with reduced area but retains general shape.',
            operationalMeaning: 'Clearance between plunger and barrel increased. Efficiency drops progressively. Both valves may still be OK.',
            actions: [
                'Schedule pump replacement',
                'Monitor efficiency trend',
                'Check sand production levels',
            ],
            features: {
                areaRatio: { min: 0.45, ideal: 0.63, max: 0.78 },
                flatTop: { min: 0.30 },
                flatBottom: { min: 0.25 },
                tvTransition: { min: 0.55 },
                svTransition: { min: 0.55 },
                fluidPoundIdx: { max: 0.28 },
            },
            weight: 0.85,
        },
        {
            id: 'rod_part',
            name: 'Rod Part (Broken Rod)',
            severity: 'critical',
            description: 'Rod string parted — surface carries only weight above break. Card shows minimal load variation, near-zero fluid load.',
            operationalMeaning: 'Rod broken. No pumping action at pump. Well is dead.',
            actions: [
                'Shut down unit immediately',
                'Fish rods',
                'Inspect rod string for cause (fatigue, corrosion, overload)',
            ],
            features: {
                areaRatio: { max: 0.50, ideal: 0.30 },
                flatTop: { max: 0.30 },
                flatBottom: { max: 0.25 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_down',
            name: 'Pump Hitting Down',
            severity: 'critical',
            description: 'Plunger bottoming out on downstroke — sharp load spike at bottom of stroke. Card shows spike in downstroke load near bottom dead center.',
            operationalMeaning: 'Plunger hitting bottom of barrel or tag bar. Causes rod buckling, barrel damage.',
            actions: [
                'Adjust rod space / rod length',
                'Check for tubing stretch',
                'Verify pump spacing',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                bottomSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_up',
            name: 'Pump Hitting Up',
            severity: 'critical',
            description: 'Plunger topping out on upstroke — sharp load spike at top of stroke. Card shows spike in upstroke load near top dead center.',
            operationalMeaning: 'Plunger hitting top of barrel or overtravel on upstroke. Can damage pump barrel, seating nipple, or rod string.',
            actions: [
                'Adjust rod space / rod length',
                'Check for fluid pound (causes overtravel)',
                'Verify stroke length setting',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                topSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'bent_barrel',
            name: 'Bent Pump Barrel / Sticking Plunger',
            severity: 'caution',
            description: 'Plunger sticking or barrel bent — erratic load patterns, asymmetric card with humps.',
            operationalMeaning: 'Mechanical interference in pump. Barrel may be bent from installation or thermal effects.',
            actions: [
                'Pull and inspect pump',
                'Check for sand or scale buildup',
                'Verify tubing alignment',
            ],
            features: {
                symmetry: { max: 0.5 },
                areaRatio: { min: 0.3, max: 0.8 },
            },
            weight: 0.9,
        },
        {
            id: 'anchor_not_holding',
            name: 'Tubing Anchor Not Holding',
            severity: 'caution',
            description: 'Tubing moves with rod string because anchor is slipping. Card shifted or shows reduced net stroke due to tubing stretch.',
            operationalMeaning: 'Tubing anchor not gripping casing. Tubing reciprocates, absorbing pump stroke. Reduced production.',
            actions: [
                'Re-set tubing anchor',
                'Consider replacing anchor',
                'Check casing ID vs anchor size',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.85 },
                tubingMovement: { min: 0.3, ideal: 0.6 },
            },
            weight: 1.0,
        },
        {
            id: 'gas_lock',
            name: 'Gas Lock',
            severity: 'critical',
            description: 'Pump completely gas-locked — no fluid being pumped. Card collapses to a narrow sliver with almost no area.',
            operationalMeaning: 'Gas fills entire barrel. Neither valve can open because gas just compresses/expands. Zero production.',
            actions: [
                'Shut down and vent casing gas',
                'Install gas separator',
                'Lower pump below perfs',
                'Consider gas anchor modification',
            ],
            features: {
                areaRatio: { max: 0.15 },
                gasCompression: { min: 0.5 },
            },
            weight: 1.4,
        },
        {
            id: 'incomplete_fillage',
            name: 'Incomplete Pump Fillage',
            severity: 'info',
            description: 'Pump not fully filling each stroke — partial fluid pound. Less severe than full fluid pound.',
            operationalMeaning: 'Inflow rate slightly below pump displacement. Some gas or void space in barrel at start of upstroke.',
            actions: [
                'Consider slowing SPM slightly',
                'Monitor fluid level trend',
                'May be acceptable if production is near target',
            ],
            features: {
                areaRatio: { min: 0.55, ideal: 0.67, max: 0.82 },
                fluidPoundIdx: { min: 0.10, max: 0.35 },
                tvTransition: { min: 0.5 },
            },
            weight: 0.85,
        },
        {
            id: 'phase_shift',
            name: 'Phase Shift in Card',
            severity: 'info',
            description: 'Card appears rotated/shifted — usually a sensor timing or calibration issue, not a pump problem.',
            operationalMeaning: 'Position encoder timing may be off, or load cell calibration drifted. Card shape is valid but phased.',
            actions: [
                'Recalibrate position sensor',
                'Check encoder alignment',
                'May indicate kinematic correction needed',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                phaseShift: { min: 0.3, ideal: 0.6 },
            },
            weight: 0.7,
        },
    ];

    // -----------------------------------------------------------------------
    // Feature Extraction
    // -----------------------------------------------------------------------

    /**
     * Extract shape features from a downhole card.
     *
     * @param {Array} position - Card position array (inches)
     * @param {Array} load     - Card load array (lbs)
     * @param {Object} rodModel - Optional rod model for reference values
     * @returns {Object} Feature vector
     */
    function extractFeatures(position, load, rodModel) {
        if (!position || !load || position.length < 10) return null;

        var N = Math.min(position.length, load.length);

        // Basic stats
        var minLoad = Infinity, maxLoad = -Infinity;
        var minPos = Infinity, maxPos = -Infinity;
        for (var i = 0; i < N; i++) {
            if (load[i] < minLoad) minLoad = load[i];
            if (load[i] > maxLoad) maxLoad = load[i];
            if (position[i] < minPos) minPos = position[i];
            if (position[i] > maxPos) maxPos = position[i];
        }

        var loadRange = maxLoad - minLoad;
        var posRange = maxPos - minPos;
        if (loadRange < 1 || posRange < 0.1) {
            return { areaRatio: 0, loadRange: 0, error: 'degenerate card' };
        }

        // Normalize to 0-1 range
        var normPos = [];
        var normLoad = [];
        for (var i = 0; i < N; i++) {
            normPos.push((position[i] - minPos) / posRange);
            normLoad.push((load[i] - minLoad) / loadRange);
        }

        // Card area (using shoelace formula on normalized card)
        var area = 0;
        for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            area += normPos[i] * normLoad[j] - normPos[j] * normLoad[i];
        }
        area = Math.abs(area) / 2;
        var areaRatio = area;  // normalized area / 1.0 (ideal rectangle)

        // Find upstroke and downstroke segments
        // Upstroke: position increasing, Downstroke: position decreasing
        var upIndices = [];
        var downIndices = [];
        var midPos = 0.5;

        // Split card at approximate top and bottom of stroke
        var topIdx = 0, botIdx = 0;
        var topPos = 0, botPos = 1;
        for (var i = 0; i < N; i++) {
            if (normPos[i] > topPos) { topPos = normPos[i]; topIdx = i; }
            if (normPos[i] < botPos) { botPos = normPos[i]; botIdx = i; }
        }

        // Upstroke: from botIdx to topIdx (going forward, wrapping)
        for (var k = 0; k < N; k++) {
            var i = (botIdx + k) % N;
            upIndices.push(i);
            if (i === topIdx) break;
        }
        // Downstroke: from topIdx to botIdx
        for (var k = 0; k < N; k++) {
            var i = (topIdx + k) % N;
            downIndices.push(i);
            if (i === botIdx) break;
        }

        // Upstroke load slope (linear regression on upstroke load vs position)
        var upstrokeSlope = calcSlope(normPos, normLoad, upIndices);
        var downstrokeSlope = calcSlope(normPos, normLoad, downIndices);

        // Flat top: fraction of upstroke where load is within 15% of max upstroke load
        var maxUpLoad = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad) maxUpLoad = normLoad[upIndices[k]];
        }
        var flatTopCount = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad * 0.85) flatTopCount++;
        }
        var flatTop = upIndices.length > 0 ? flatTopCount / upIndices.length : 0;

        // Flat bottom: fraction of downstroke where load is within 15% of min downstroke load
        var minDownLoad = 1;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad) minDownLoad = normLoad[downIndices[k]];
        }
        var flatBotCount = 0;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad + 0.15) flatBotCount++;
        }
        var flatBottom = downIndices.length > 0 ? flatBotCount / downIndices.length : 0;

        // TV transition sharpness: how quickly load picks up at bottom of stroke
        var tvRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.15)));
        var tvTransition = 0;
        if (tvRegion.length > 1) {
            var loadJump = normLoad[tvRegion[tvRegion.length - 1]] - normLoad[tvRegion[0]];
            var posJump = normPos[tvRegion[tvRegion.length - 1]] - normPos[tvRegion[0]];
            tvTransition = posJump > 0.001 ? Math.min(1, loadJump / (posJump * 4)) : 0;
        }

        // SV transition sharpness: how quickly load drops at top of stroke
        var svRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.15)));
        var svTransition = 0;
        if (svRegion.length > 1) {
            var loadDrop = normLoad[svRegion[0]] - normLoad[svRegion[svRegion.length - 1]];
            var posDrop = normPos[svRegion[0]] - normPos[svRegion[svRegion.length - 1]];
            svTransition = Math.abs(posDrop) > 0.001 ? Math.min(1, loadDrop / (Math.abs(posDrop) * 4)) : 0;
        }

        // Fluid pound index: detect sharp load drop during downstroke
        var fluidPoundIdx = 0;
        if (downIndices.length > 5) {
            var maxDrop = 0;
            for (var k = 1; k < downIndices.length; k++) {
                var prevI = downIndices[k - 1];
                var curI = downIndices[k];
                var drop = normLoad[prevI] - normLoad[curI];
                if (drop > maxDrop) maxDrop = drop;
            }
            fluidPoundIdx = Math.min(1, maxDrop * 3);
        }

        // Gas compression: gradual load buildup (vs sharp TV transition)
        var gasCompression = Math.max(0, 1 - tvTransition);

        // Symmetry: compare first half vs second half shape
        var halfN = Math.floor(N / 2);
        var symDiff = 0;
        for (var i = 0; i < halfN; i++) {
            var mirrorI = N - 1 - i;
            symDiff += Math.abs(normLoad[i] - normLoad[mirrorI]);
        }
        var symmetry = halfN > 0 ? 1 - Math.min(1, symDiff / halfN) : 0.5;

        // Load range ratio (vs expected fluid load)
        var loadRangeRatio = 1.0;
        if (rodModel) {
            var plungerArea = Math.PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
            var expectedFluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
            if (expectedFluidLoad > 0) {
                loadRangeRatio = loadRange / expectedFluidLoad;
            }
        }

        // Bottom spike (pump hitting down)
        var bottomSpike = 0;
        var bottomRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.1)));
        if (bottomRegion.length > 1) {
            var spikeLoad = 0;
            for (var k = 0; k < bottomRegion.length; k++) {
                if (normLoad[bottomRegion[k]] > spikeLoad) spikeLoad = normLoad[bottomRegion[k]];
            }
            var avgUpLoad = 0;
            for (var k = 0; k < upIndices.length; k++) avgUpLoad += normLoad[upIndices[k]];
            avgUpLoad /= upIndices.length;
            if (spikeLoad > avgUpLoad * 1.3) bottomSpike = Math.min(1, (spikeLoad - avgUpLoad) * 3);
        }

        // Top spike (pump hitting up)
        var topSpike = 0;
        var topRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.1)));
        if (topRegion.length > 1) {
            var topSpikeLoad = 1;
            for (var k = 0; k < topRegion.length; k++) {
                if (normLoad[topRegion[k]] < topSpikeLoad) topSpikeLoad = normLoad[topRegion[k]];
            }
            var avgDownLoad = 0;
            for (var k = 0; k < downIndices.length; k++) avgDownLoad += normLoad[downIndices[k]];
            avgDownLoad /= downIndices.length;
            if (topSpikeLoad < avgDownLoad * 0.7) topSpike = Math.min(1, (avgDownLoad - topSpikeLoad) * 3);
        }

        // Tubing movement: difference in position at same load levels
        var tubingMovement = 0;
        // Compare position at mid-load during upstroke vs downstroke
        var midLoadLevel = 0.5;
        var upMidPos = interpPosAtLoad(normPos, normLoad, upIndices, midLoadLevel);
        var downMidPos = interpPosAtLoad(normPos, normLoad, downIndices, midLoadLevel);
        if (upMidPos !== null && downMidPos !== null) {
            tubingMovement = Math.abs(upMidPos - downMidPos);
        }

        // Phase shift: detect if card is rotated from expected orientation
        var phaseShift = 0;
        // If max load occurs far from bottom of stroke or min load far from top
        var maxLoadPos = normPos[0];
        for (var i = 1; i < N; i++) {
            if (normLoad[i] === maxLoad) maxLoadPos = normPos[i];
        }
        if (maxLoadPos > 0.6 || maxLoadPos < 0.1) phaseShift = 0.5;

        // C-to-D transition sharpness (sharp = full pump/fluid pound, gradual = gas interference)
        // Uses AVERAGE slope over the first 30% of downstroke (not max, which saturates).
        // Published criterion: gas interference has gradual/rounded C-D (avg < 3),
        // fluid pound has sharp C-D (avg > 3), full pump has very sharp (avg > 8).
        var cdSharpness = 0;
        if (downIndices.length > 5) {
            var cdSeg = downIndices.slice(0, Math.max(5, Math.floor(downIndices.length * 3 / 10)));
            var cdSum = 0, cdCount = 0;
            for (var k = 1; k < cdSeg.length; k++) {
                var cdDP = Math.abs(normPos[cdSeg[k]] - normPos[cdSeg[k - 1]]);
                var cdDL = normLoad[cdSeg[k - 1]] - normLoad[cdSeg[k]];
                if (cdDP > 0.001) {
                    cdSum += cdDL / cdDP;
                    cdCount++;
                }
            }
            if (cdCount > 0) cdSharpness = Math.min(1, (cdSum / cdCount) / 15.0);
        }

        // A-to-B transition sharpness (sharp = normal/full pump, gradual = gas/TV leak)
        // Same avg slope approach, normalized to 0-1 range (÷15).
        var abSharpness = 0;
        if (upIndices.length > 5) {
            var abSeg = upIndices.slice(0, Math.max(5, Math.floor(upIndices.length * 3 / 10)));
            var abSum = 0, abCount = 0;
            for (var k = 1; k < abSeg.length; k++) {
                var abDP = Math.abs(normPos[abSeg[k]] - normPos[abSeg[k - 1]]);
                var abDL = normLoad[abSeg[k]] - normLoad[abSeg[k - 1]];
                if (abDP > 0.001) {
                    abSum += abDL / abDP;
                    abCount++;
                }
            }
            if (abCount > 0) abSharpness = Math.min(1, (abSum / abCount) / 15.0);
        }

        // Downstroke load elevation (mean mid-downstroke load, normalized)
        // High = SV leak (downstroke load elevated above zero line)
        var dnLoadElev = 0;
        if (downIndices.length > 4) {
            var midDnStart = Math.floor(downIndices.length / 4);
            var midDnEnd = Math.floor(3 * downIndices.length / 4);
            var dnSum = 0, dnCount = 0;
            for (var k = midDnStart; k < midDnEnd; k++) {
                dnSum += normLoad[downIndices[k]];
                dnCount++;
            }
            if (dnCount > 0) dnLoadElev = dnSum / dnCount;
        }

        // Upstroke load drop point (fraction of upstroke before load drops below 80% of max)
        // Late = full pump, early = fluid pound / incomplete fillage
        var upDropPt = 1.0;
        if (upIndices.length > 5) {
            var upMaxLoad = 0;
            for (var k = 0; k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] > upMaxLoad) upMaxLoad = normLoad[upIndices[k]];
            }
            var dropThresh = upMaxLoad * 0.80;
            for (var k = Math.floor(upIndices.length / 4); k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] < dropThresh) {
                    upDropPt = k / upIndices.length;
                    break;
                }
            }
        }

        return {
            areaRatio: areaRatio,
            loadRange: loadRangeRatio,
            upstrokeSlope: upstrokeSlope,
            downstrokeSlope: downstrokeSlope,
            tvTransition: tvTransition,
            svTransition: svTransition,
            flatTop: flatTop,
            flatBottom: flatBottom,
            fluidPoundIdx: fluidPoundIdx,
            gasCompression: gasCompression,
            symmetry: symmetry,
            bottomSpike: bottomSpike,
            topSpike: topSpike,
            tubingMovement: tubingMovement,
            phaseShift: phaseShift,
            cdSharpness: cdSharpness,
            abSharpness: abSharpness,
            dnLoadElev: dnLoadElev,
            upDropPt: upDropPt,
            // Raw stats for display
            _minLoad: minLoad,
            _maxLoad: maxLoad,
            _minPos: minPos,
            _maxPos: maxPos,
            _loadRange: loadRange,
            _posRange: posRange,
            _cardArea: area,
        };
    }

    function calcSlope(xArr, yArr, indices) {
        if (indices.length < 3) return 0;
        var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        var n = indices.length;
        for (var k = 0; k < n; k++) {
            var x = xArr[indices[k]];
            var y = yArr[indices[k]];
            sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
        }
        var denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }

    function interpPosAtLoad(normPos, normLoad, indices, targetLoad) {
        for (var k = 1; k < indices.length; k++) {
            var prev = indices[k - 1], cur = indices[k];
            var l0 = normLoad[prev], l1 = normLoad[cur];
            if ((l0 <= targetLoad && l1 >= targetLoad) || (l0 >= targetLoad && l1 <= targetLoad)) {
                if (Math.abs(l1 - l0) < 1e-10) return normPos[prev];
                var frac = (targetLoad - l0) / (l1 - l0);
                return normPos[prev] + frac * (normPos[cur] - normPos[prev]);
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Pattern Matching
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Empirical Centroids — computed from 47 wells (2026-03-23)
    //
    // Each centroid is [areaRatio, flatTop, flatBottom, fluidPoundIdx,
    //   svTransition, tvTransition, cdSharpness, abSharpness, dnLoadElev, upDropPt]
    // with corresponding standard deviations. Used by the nearest-centroid
    // classifier to score each pattern.
    //
    // New features from published diagnostic criteria:
    //   cdSharpness: C-to-D transition slope (sharp=fluid pound, gradual=gas)
    //   abSharpness: A-to-B transition slope (sharp=normal, gradual=TV leak/gas)
    //   dnLoadElev:  mean mid-downstroke load (high=SV leak)
    //   upDropPt:    fraction of upstroke before load drops (late=full pump)
    // -----------------------------------------------------------------------
    var CENTROIDS = {
        full_pump:          { mean: [0.834, 0.739, 0.710, 0.160, 1.000, 1.000, 0.644, 0.836, 0.059, 0.952], std: [0.05, 0.08, 0.07, 0.05, 0.05, 0.05, 0.15, 0.17, 0.05, 0.05], n: 4 },
        fluid_pound:        { mean: [0.577, 0.647, 0.400, 0.297, 0.237, 0.675, 0.187, 0.360, 0.241, 0.655], std: [0.22, 0.25, 0.20, 0.22, 0.41, 0.39, 0.26, 0.37, 0.14, 0.34], n: 17 },
        gas_interference:   { mean: [0.634, 0.562, 0.344, 0.242, 0.584, 0.616, 0.283, 0.390, 0.229, 0.641], std: [0.08, 0.25, 0.09, 0.12, 0.42, 0.41, 0.27, 0.34, 0.05, 0.36], n: 4 },
        incomplete_fillage: { mean: [0.690, 0.450, 0.526, 0.205, -0.024, 0.885, 0.512, 0.753, 0.154, 0.268], std: [0.10, 0.20, 0.16, 0.09, 1.12, 0.28, 0.35, 0.16, 0.06, 0.05], n: 7 },
        bent_barrel:        { mean: [0.744, 0.781, 0.411, 0.254, 0.879, 1.000, 0.373, 0.495, 0.141, 0.946], std: [0.05, 0.10, 0.24, 0.05, 0.12, 0.05, 0.30, 0.35, 0.05, 0.05], n: 2 },
        sv_leak:            { mean: [0.755, 0.651, 0.394, 0.209, 1.000, 0.340, 0.580, 0.176, 0.100, 0.662], std: [0.05, 0.12, 0.14, 0.06, 0.05, 0.48, 0.21, 0.16, 0.05, 0.21], n: 3 },
        tv_leak:            { mean: [0.823, 0.695, 0.920, 0.134, 0.554, 1.000, 0.361, 0.484, 0.061, 0.909], std: [0.05, 0.06, 0.05, 0.05, 0.45, 0.05, 0.23, 0.08, 0.05, 0.05], n: 2 },
        worn_pump:          { mean: [0.824, 0.703, 0.728, 0.145, 1.000, 1.000, 0.878, 0.932, 0.056, 0.960], std: [0.05, 0.08, 0.05, 0.05, 0.05, 0.05, 0.12, 0.07, 0.05, 0.05], n: 2 },
        rod_part:           { mean: [0.311, 0.103, 0.095, 0.060, -0.814, -0.820, -0.070, -0.050, 0.781, 0.247], std: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15], n: 1 },
    };

    /**
     * Centroid-first hybrid classifier with physics overrides.
     *
     * Strategy: Use nearest-centroid (trained on 47 XSPOC wells) as the primary
     * classifier, then apply physics-based overrides ONLY for unambiguous cases
     * where published criteria give a definitive answer.
     *
     * Physics overrides (from Echometer TechNotes, Downhole Diagnostic,
     * SPE-173964, McCoy/Rowlan/Podio SWPSC 2015):
     *   - Rod part: area < 0.20, near-flat card → override to rod_part (0.95)
     *   - Gas lock: area < 0.15 → override to gas_lock (0.90)
     *   - Full pump: area > 0.78, flat top > 0.68, flat bottom > 0.60,
     *     AND sharp A-B (ab > 0.30) → override to full_pump (0.90)
     *     Physical basis: liquid is incompressible → sharp corners. If A-B is
     *     rounded, gas is present and it's NOT full pump.
     *   - Gas interference VETO: if ab > 0.40, the A-B transition is too sharp
     *     for gas. Published: "gas compresses before valves open → gradual A-B."
     *     Sharp A-B = liquid only = NOT gas interference.
     *
     * @param {Object} features - From extractFeatures()
     * @returns {Array} [{pattern, confidence, physicsRule, matchDetails}, ...]
     */
    function diagnose(features) {
        if (!features || features.error) return [];

        var f = features;

        // ── Step 1: Centroid classifier (primary) ──
        var fNames = ['areaRatio', 'flatTop', 'flatBottom', 'fluidPoundIdx',
                      'svTransition', 'tvTransition', 'cdSharpness', 'abSharpness',
                      'dnLoadElev', 'upDropPt'];
        var fVec = [];
        for (var fi = 0; fi < fNames.length; fi++) {
            var val = f[fNames[fi]];
            if (val === undefined || val === null || isNaN(val)) return [];
            fVec.push(val);
        }

        // Compute normalized distance to each centroid
        var centroidResults = [];
        var sumExp = 0;
        for (var cid in CENTROIDS) {
            if (!CENTROIDS.hasOwnProperty(cid)) continue;
            var cent = CENTROIDS[cid];
            var dist = 0;
            for (var i = 0; i < fVec.length; i++) {
                var std = Math.max(cent.std[i], 0.05);
                var d = (fVec[i] - cent.mean[i]) / std;
                dist += d * d;
            }
            dist = Math.sqrt(dist);
            var bonus = Math.log(Math.max(cent.n, 1) + 1) * 0.3;
            var score = -dist + bonus;
            var expScore = Math.exp(score);
            sumExp += expScore;
            centroidResults.push({ id: cid, dist: dist, score: score, expScore: expScore });
        }

        // Softmax confidence
        for (var i = 0; i < centroidResults.length; i++) {
            centroidResults[i].confidence = sumExp > 0 ? centroidResults[i].expScore / sumExp : 0;
        }
        centroidResults.sort(function (a, b) { return b.confidence - a.confidence; });

        // ── Step 2: Physics overrides (only for unambiguous cases) ──
        var ar = f.areaRatio, ft = f.flatTop, fb = f.flatBottom;
        var ab = f.abSharpness, cd = f.cdSharpness, dnE = f.dnLoadElev;
        var override = null;

        // Override A: Rod part — tiny flat card, no pump action
        if (ar < 0.20 && ft < 0.25 && fb < 0.25) {
            override = {
                id: 'rod_part', confidence: 0.95,
                reason: 'Card area ' + ar.toFixed(2) + ' — near-flat, minimal load variation. Rod string parted or sensor failure. (Published: rod part card is small flat loop.)'
            };
        }

        // Override B: Gas lock — card collapsed to sliver/figure-8
        if (ar < 0.15 && !override) {
            override = {
                id: 'gas_lock', confidence: 0.90,
                reason: 'Card collapsed to ' + ar.toFixed(2) + ' area. Neither valve can open — gas compresses and expands without transferring fluid. (Published: gas lock = tiny ellipse.)'
            };
        }

        // Gas interference VETO — sharp A-B rules out gas
        // Published (Downhole Diagnostic, EngineerFix, Echometer): "Gas acts as
        // a cushion, resulting in sloped transitions." If A-B is sharp, liquid
        // is moving without gas compression → NOT gas interference.
        // Physical basis: liquid is incompressible → instantaneous valve action
        // → sharp corners. Gas is compressible → gradual corners.
        var gasVeto = (ab > 0.40);

        // ── Step 3: Build final results ──
        var results = [];

        if (override) {
            // Physics override is primary — find matching pattern
            var overridePattern = null;
            for (var p = 0; p < PATTERNS.length; p++) {
                if (PATTERNS[p].id === override.id) { overridePattern = PATTERNS[p]; break; }
            }
            if (overridePattern) {
                results.push({
                    pattern: overridePattern,
                    confidence: override.confidence,
                    physicsRule: override.reason,
                    matchDetails: {},
                });
            }

            // Add centroid results as alternatives (lower confidence)
            for (var i = 0; i < Math.min(2, centroidResults.length); i++) {
                if (centroidResults[i].id === override.id) continue;
                var altPattern = null;
                for (var p = 0; p < PATTERNS.length; p++) {
                    if (PATTERNS[p].id === centroidResults[i].id) { altPattern = PATTERNS[p]; break; }
                }
                if (altPattern) {
                    results.push({
                        pattern: altPattern,
                        confidence: Math.round(centroidResults[i].confidence * 50) / 100, // halved
                        physicsRule: 'Statistical match (centroid). Overridden by physics rule.',
                        matchDetails: {},
                    });
                }
            }
        } else {
            // No override — use centroid results directly
            for (var i = 0; i < Math.min(3, centroidResults.length); i++) {
                var cid = centroidResults[i].id;

                // Apply gas interference veto
                if (cid === 'gas_interference' && gasVeto) {
                    // Skip gas interference, promote next result
                    continue;
                }

                var pattern = null;
                for (var p = 0; p < PATTERNS.length; p++) {
                    if (PATTERNS[p].id === cid) { pattern = PATTERNS[p]; break; }
                }
                if (!pattern) continue;

                var conf = Math.round(centroidResults[i].confidence * 100) / 100;
                var reason = 'Nearest centroid match (distance=' + centroidResults[i].dist.toFixed(1) + ').';

                // Add physics reasoning when available
                if (cid === 'gas_interference' && ab < 0.25 && cd < 0.30) {
                    reason = 'Both A-B (' + ab.toFixed(2) + ') and C-D (' + cd.toFixed(2) + ') corners rounded — banana/football shape. Gas compression delays valve action. (Published: gas = sloped transitions, not vertical.)';
                } else if (cid === 'fluid_pound' && cd > 0.25) {
                    reason = 'Sharp C-D transition (' + cd.toFixed(2) + ') — plunger hits liquid surface. Incompressible fluid → right-angle valve action. (Published: fluid pound = impact spike at bottom-right.)';
                } else if (cid === 'tv_leak' && f.upstrokeSlope < -0.15) {
                    reason = 'Upstroke load declining (slope=' + f.upstrokeSlope.toFixed(2) + '). Fluid leaking past TV/plunger during upstroke. (Published: TV leak = upper corners rounded off, load falls during upstroke.)';
                } else if (cid === 'sv_leak' && dnE > 0.20) {
                    reason = 'Downstroke load elevated (' + dnE.toFixed(2) + '). Fluid leaking back through SV during downstroke. (Published: SV leak = downstroke load higher than normal.)';
                } else if (cid === 'full_pump') {
                    reason = 'Rectangular card (area=' + f.areaRatio.toFixed(2) + '). (Published: ideal pump card approaches perfect rectangle.)';
                } else if (cid === 'incomplete_fillage') {
                    reason = 'Moderate area reduction (' + f.areaRatio.toFixed(2) + ') without strong valve leak or gas signature. Partial fillage.';
                }

                results.push({
                    pattern: pattern,
                    confidence: conf,
                    physicsRule: reason,
                    matchDetails: {},
                });
            }
        }

        results.sort(function (a, b) { return b.confidence - a.confidence; });
        return results;
    }

    /**
     * Get a human-readable diagnosis summary.
     *
     * @param {Array} position - Downhole card position
     * @param {Array} load     - Downhole card load
     * @param {Object} rodModel - Optional rod model
     * @returns {Object} {primary, secondary, features, allMatches}
     */
    function analyzeCard(position, load, rodModel) {
        var features = extractFeatures(position, load, rodModel);
        if (!features) return { primary: null, error: 'Could not extract features' };

        var matches = diagnose(features);

        return {
            primary: matches.length > 0 ? matches[0] : null,
            secondary: matches.length > 1 ? matches[1] : null,
            features: features,
            allMatches: matches,
        };
    }

    // Public API
    return {
        PATTERNS: PATTERNS,
        extractFeatures: extractFeatures,
        diagnose: diagnose,
        analyzeCard: analyzeCard,
    };
})();
