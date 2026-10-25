// <ACEStransformID>urn:ampas:aces:transformId:v1.5:IDT.DJI.DLog2_DGamut2.a1.v1</ACEStransformID> 
// <ACESuserName>ACES 1.0 Input - DJI DLog2 DGamut2</ACESuserName> 
//
// IDT for DLog2 DGamut2 by DJI

import "Lib.Academy.Utilities";
import "Lib.Academy.ColorSpaces";
import "Lib.Academy.Tonescale";
import "Lib.Academy.OutputTransform";
import "Lib.Academy.DisplayEncoding";


const Chromaticities DGamut2_PRI = 
{
  { 0.7347,    0.2653},
  { 0.1600,    0.8400},
  { 0.0900,    -0.0800},
  { 0.3127,    0.3290}
};


const float DGamut2_TO_AP0_MAT[3][3] = 
                        calculate_rgb_to_rgb_matrix( DGamut2_PRI,
                                                     AP0,
                                                     CONE_RESP_MAT_CAT02 );

float dlog2_to_lin(float x) {
    float H = 475.0;
    float a = 16.285770761945304;
    float k1 = 0.059439938321493;
    float b1 = 0.304985337243402;
    float k2 = 2.960935245492250;
    float b2 = 0.148314799066323;
    float in_limit1 = 0.18;
    float in_limit2 = 0.028961695254132;
    float in_limit_rev_1 = 0.304985337243402;
    float in_limit_rev_2 = 0.148314799066323;
	
	if(x >= in_limit_rev_1)
		return (H / (pow(2, a) - 1.0) * (pow(2, a * x)-1));
	else if(x >= in_limit_rev_2) 
		return (pow(2, (x - b1) / k1  + log2(in_limit1)));
	else
		return ((x - b2) / k2 + in_limit2);
}

void main
	(
	input varying float rIn,
	input varying float gIn,
	input varying float bIn,
	output varying float rOut,
	output varying float gOut,
	output varying float bOut
)

{
   float lin_rgb[3];
   lin_rgb[0] = dlog2_to_lin(rIn);
   lin_rgb[1] = dlog2_to_lin(gIn);
   lin_rgb[2] = dlog2_to_lin(bIn);

   float ACES[3] = mult_f3_f33(lin_rgb, DGamut2_TO_AP0_MAT);

   rOut = ACES[0];
   gOut = ACES[1];
   bOut = ACES[2];   
}